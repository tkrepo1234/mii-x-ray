using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace MiiXRay.Model
{
    /// <summary>Reads the MII export formats (.trx and the query templates) into the model.</summary>
    public static class ObjectReader
    {
        private static readonly Regex ParamSlotInText = new Regex(@"\[Param\.(\d+)\]", RegexOptions.Compiled);

        public static bool IsTransaction(XmlDocument document)
        {
            return document.DocumentElement != null && document.DocumentElement.LocalName == "Transaction";
        }

        public static MiiTransaction ReadTransaction(string path, XmlDocument document)
        {
            XmlElement root = document.DocumentElement;
            MiiTransaction transaction = new MiiTransaction();
            transaction.Path = path;
            transaction.Description = ReadAttribute(MiiXml.Child(root, "TransactionAttributes"), "Description");

            foreach (XmlElement item in MiiXml.Children(MiiXml.Child(root, "Context"), "ContextItem"))
            {
                MiiParameter parameter = ReadParameter(item);
                parameter.IsOutput = string.Equals(MiiXml.ChildText(item, "ReadOnly").Trim(), "true", StringComparison.OrdinalIgnoreCase);

                if (parameter.IsOutput)
                {
                    transaction.Outputs.Add(parameter);
                }
                else
                {
                    transaction.Inputs.Add(parameter);
                }
            }

            foreach (XmlElement item in MiiXml.Children(MiiXml.Child(root, "Local"), "ContextItem"))
            {
                transaction.Locals.Add(ReadParameter(item));
            }

            foreach (XmlElement item in MiiXml.Children(MiiXml.Child(root, "Actions"), "ContextItem"))
            {
                MiiActionDefinition definition = new MiiActionDefinition();
                definition.Name = MiiXml.ChildText(item, "Name");
                definition.Value = MiiXml.Child(item, "Value");
                definition.ActionType = MiiXml.XsiType(definition.Value);

                if (definition.Name.Length > 0 && !transaction.Actions.ContainsKey(definition.Name))
                {
                    transaction.Actions.Add(definition.Name, definition);
                }
            }

            foreach (XmlElement step in MiiXml.Children(MiiXml.Child(root, "Steps"), "Step"))
            {
                transaction.Steps.Add(ReadStep(step, transaction));
            }

            return transaction;
        }

        private static string ReadAttribute(XmlElement attributes, string name)
        {
            foreach (XmlElement item in MiiXml.Children(attributes, "ContextItem"))
            {
                if (MiiXml.ChildText(item, "Name") == name)
                {
                    return MiiXml.OwnText(MiiXml.Child(item, "Value")).Trim();
                }
            }

            return string.Empty;
        }

        private static MiiParameter ReadParameter(XmlElement item)
        {
            MiiParameter parameter = new MiiParameter();
            XmlElement value = MiiXml.Child(item, "Value");
            parameter.Name = MiiXml.ChildText(item, "Name");
            parameter.Description = MiiXml.ChildText(item, "Description").Trim();
            parameter.Type = MiiXml.XsiType(value);
            parameter.DefaultText = MiiXml.OwnText(value);
            parameter.ReferenceSource = MiiXml.ChildText(value, "ReferenceDocumentSource").Trim();

            if (parameter.Type != "xml")
            {
                parameter.DefaultText = parameter.DefaultText.Trim();
            }

            return parameter;
        }

        private static MiiStep ReadStep(XmlElement element, MiiTransaction transaction)
        {
            MiiStep step = new MiiStep();
            step.StepType = MiiXml.XsiType(element);
            step.Name = MiiXml.ChildText(element, "Name");
            XmlElement action = MiiXml.Child(MiiXml.Child(element, "Actions"), "Action");

            if (action != null)
            {
                MiiActionUse use = new MiiActionUse();
                use.Name = MiiXml.ChildText(action, "Name");
                use.Incoming = ReadLinks(MiiXml.Child(action, "IncomingLinks"));
                use.Outgoing = ReadLinks(MiiXml.Child(action, "OutgoingLinks"));
                MiiActionDefinition definition;

                if (transaction.Actions.TryGetValue(use.Name, out definition))
                {
                    use.Definition = definition;
                }

                step.Action = use;
            }

            foreach (XmlElement child in MiiXml.Children(MiiXml.Child(element, "Steps"), "Step"))
            {
                step.Children.Add(ReadStep(child, transaction));
            }

            return step;
        }

        private static List<MiiLink> ReadLinks(XmlElement links)
        {
            List<MiiLink> result = new List<MiiLink>();

            foreach (XmlElement assign in MiiXml.Children(links, "Assign"))
            {
                MiiLink link = new MiiLink();
                link.Kind = MiiXml.XsiType(assign);

                if (link.Kind.Length == 0)
                {
                    link.Kind = "Assign";
                }

                link.From = MiiXml.ChildText(assign, "From");
                link.To = MiiXml.ChildText(assign, "To").Trim();
                result.Add(link);
            }

            return result;
        }

        // ------------------------------------------------------------------ query templates

        public static MiiQuery ReadQuery(string path, XmlDocument document)
        {
            XmlElement root = document.DocumentElement;
            MiiQuery query = new MiiQuery();
            query.Path = path;
            query.RootName = root.LocalName;
            query.Mode = root.GetAttribute("Mode");

            switch (root.LocalName)
            {
                case "SQLQuery":
                    query.Kind = MiiQueryKind.Sql;
                    query.Text = root.GetAttribute("Query");
                    break;
                case "MDOQuery":
                    query.Kind = MiiQueryKind.Mdo;
                    query.Text = BuildMdoStatement(root);
                    break;
                case "XMLQuery":
                    query.Kind = MiiQueryKind.Xml;
                    query.Url = root.GetAttribute("URL");
                    query.Text = query.Url;
                    break;
                case "XacuteQuery":
                    query.Kind = MiiQueryKind.Xacute;
                    query.XacuteTransaction = root.GetAttribute("Transaction").Trim();
                    query.XacuteOutputParameter = root.GetAttribute("OutputParameter").Trim();

                    for (int slot = 1; slot <= 32; slot++)
                    {
                        string target = root.GetAttribute("MappedParamTarget." + slot.ToString(CultureInfo.InvariantCulture)).Trim();

                        if (target.Length > 0)
                        {
                            query.XacuteMappedTargets[slot] = target;
                        }
                    }

                    query.Text = string.Empty;
                    break;
                default:
                    query.Kind = MiiQueryKind.Other;
                    query.Text = root.GetAttribute("Query");
                    break;
            }

            if (query.Text == null)
            {
                query.Text = string.Empty;
            }

            ReadQueryParameters(root, query);
            return query;
        }

        private static void ReadQueryParameters(XmlElement root, MiiQuery query)
        {
            Dictionary<int, bool> inText = new Dictionary<int, bool>();

            foreach (Match match in ParamSlotInText.Matches(query.Text))
            {
                inText[int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture)] = true;
            }

            for (int slot = 1; slot <= 32; slot++)
            {
                string suffix = slot.ToString(CultureInfo.InvariantCulture);
                string description = root.GetAttribute("ParamDescription." + suffix).Trim();
                string type = root.GetAttribute("ParamType." + suffix).Trim();
                string value = root.GetAttribute("Param." + suffix);
                bool mapped = query.XacuteMappedTargets.ContainsKey(slot);

                if (description.Length == 0 && !inText.ContainsKey(slot) && !mapped)
                {
                    continue;
                }

                MiiQueryParameter parameter = new MiiQueryParameter();
                parameter.Slot = slot;
                parameter.Description = description;
                parameter.Type = type;
                parameter.DefaultValue = value;
                query.Parameters.Add(parameter);
            }
        }

        /// <summary>An MDO query has no statement text; X-Ray writes a readable one from its settings.</summary>
        private static string BuildMdoStatement(XmlElement root)
        {
            string mdo = root.GetAttribute("MDO");
            string mode = root.GetAttribute("Mode");
            string filter = root.GetAttribute("FilterExpr").Trim();
            string sort = root.GetAttribute("SortExpr").Trim();
            StringBuilder text = new StringBuilder();
            text.Append("/* MDO query, mode ").Append(mode).Append(" */ ");

            if (string.Equals(mode, "Select", StringComparison.OrdinalIgnoreCase))
            {
                string attributes = root.GetAttribute("Attributes").Trim();
                text.Append("SELECT ").Append(attributes.Length > 0 ? attributes : "*").Append(" FROM [").Append(mdo).Append("]");
            }
            else if (string.Equals(mode, "Delete", StringComparison.OrdinalIgnoreCase))
            {
                text.Append("DELETE FROM [").Append(mdo).Append("]");
            }
            else
            {
                List<string> assignments = new List<string>();

                for (int index = 1; index <= 128; index++)
                {
                    string suffix = index.ToString(CultureInfo.InvariantCulture);
                    string name = root.GetAttribute("AttributeName." + suffix).Trim();

                    if (name.Length > 0)
                    {
                        assignments.Add("[" + name + "] = " + root.GetAttribute("AttributeValue." + suffix).Trim());
                    }
                }

                if (string.Equals(mode, "Insert", StringComparison.OrdinalIgnoreCase))
                {
                    text.Append("INSERT INTO [").Append(mdo).Append("] SET ").Append(string.Join(", ", assignments.ToArray()));
                }
                else
                {
                    text.Append(mode.ToUpperInvariant()).Append(" [").Append(mdo).Append("] SET ").Append(string.Join(", ", assignments.ToArray()));
                }
            }

            if (filter.Length > 0)
            {
                text.Append(" WHERE ").Append(filter);
            }

            if (sort.Length > 0)
            {
                text.Append(" ORDER BY ").Append(sort);
            }

            return text.ToString();
        }
    }
}
