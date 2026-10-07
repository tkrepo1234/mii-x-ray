using System;
using System.Collections.Generic;
using System.Globalization;
using System.Xml;
using MiiXRay.Model;

namespace MiiXRay.Generate
{
    public sealed class RowsetColumn
    {
        /// <summary>The element name in the MII rowset document.</summary>
        public string Name;
        public string PropertyName;
        public CsType Type;
        /// <summary>A guess from the SQL text; the spelling of a later confirmed use wins.</summary>
        public bool Tentative;

        /// <summary>True when the generated code reads the column by name.</summary>
        public bool Read;
    }

    /// <summary>The typed form of an MII rowset document (Rowsets/Rowset/Row): a row record; the rowset is a List of it.
    /// Columns come from reference documents, cached query results, column specifications, the SQL text and from
    /// the columns the transactions read (Row/Column in XPath expressions).</summary>
    public sealed class RowsetContract
    {
        private readonly List<RowsetColumn> _columns = new List<RowsetColumn>();
        private readonly string _rowClass;
        private readonly string _origin;

        public RowsetContract(string rowClass, string origin)
        {
            _rowClass = rowClass;
            _origin = origin;
        }

        public string RowClass
        {
            get { return _rowClass; }
        }

        public string RowTypeName
        {
            get { return _rowClass; }
        }

        public string RowsetTypeName
        {
            get { return "List<" + _rowClass + ">"; }
        }

        /// <summary>Where the columns come from (for the class comment).</summary>
        public string Origin
        {
            get { return _origin; }
        }

        public List<RowsetColumn> Columns
        {
            get { return _columns; }
        }

        /// <summary>True when a whole document of this contract is passed on (to an output, a call, a log, a string),
        /// so columns that are not read by name may still be used further on.</summary>
        public bool PassedOnWhole { get; set; }

        /// <summary>"Sfc,Item,..." - used to share identical contracts.</summary>
        public string Signature
        {
            get
            {
                List<string> names = new List<string>();

                foreach (RowsetColumn column in _columns)
                {
                    names.Add(column.Name + ":" + column.Type.Name);
                }

                return string.Join(",", names.ToArray());
            }
        }

        public RowsetColumn Find(string name)
        {
            foreach (RowsetColumn column in _columns)
            {
                if (column.Name == name)
                {
                    return column;
                }
            }

            return null;
        }

        /// <summary>The column with this name; a tentative column with another spelling is renamed, an unknown one is added.</summary>
        public RowsetColumn Ensure(string name)
        {
            return Add(name, CsType.String, false);
        }

        public RowsetColumn Add(string name, CsType type, bool tentative)
        {
            RowsetColumn existing = Find(name);

            if (existing == null)
            {
                foreach (RowsetColumn candidate in _columns)
                {
                    if (string.Equals(candidate.Name, name, StringComparison.OrdinalIgnoreCase) && (tentative || candidate.Tentative))
                    {
                        existing = candidate;
                        break;
                    }
                }
            }

            if (existing != null)
            {
                if (!tentative && existing.Tentative)
                {
                    existing.Name = name;
                    existing.PropertyName = PropertyNameFor(name);
                    existing.Type = type;
                    existing.Tentative = false;
                }

                return existing;
            }

            RowsetColumn column = new RowsetColumn();
            column.Name = name;
            column.PropertyName = PropertyNameFor(name);
            column.Type = type;
            column.Tentative = tentative;
            _columns.Add(column);
            return column;
        }

        private string PropertyNameFor(string name)
        {
            string property = Naming.Sanitize(name);

            if (property == _rowClass || !Naming.IsValidIdentifier(property))
            {
                property = Naming.Pascal(property) + "Column";
            }

            UniqueNames names = new UniqueNames();
            names.Reserve(_rowClass);

            foreach (RowsetColumn other in _columns)
            {
                if (other.Name != name)
                {
                    names.Reserve(other.PropertyName);
                }
            }

            return names.Claim(property);
        }
    }

    /// <summary>Creates contracts from the material MII leaves in the objects.</summary>
    public static class ContractFactory
    {
        /// <summary>A contract from an Illuminator rowset document (Columns or the first Row); null when the document is no rowset.</summary>
        public static bool AddColumnsFromRowsets(RowsetContract contract, XmlDocument document)
        {
            if (document == null || document.DocumentElement == null || document.DocumentElement.LocalName != "Rowsets")
            {
                return false;
            }

            XmlElement rowset = MiiXml.Child(document.DocumentElement, "Rowset");

            if (rowset == null)
            {
                return true;
            }

            XmlElement columns = MiiXml.Child(rowset, "Columns");
            List<XmlElement> columnElements = MiiXml.Children(columns, "Column");

            if (columnElements.Count > 0)
            {
                foreach (XmlElement column in columnElements)
                {
                    string name = column.GetAttribute("Name").Trim();

                    if (name.Length > 0)
                    {
                        contract.Add(name, TypeOfSqlDataType(column.GetAttribute("SQLDataType")), false);
                    }
                }

                return true;
            }

            XmlElement row = MiiXml.Child(rowset, "Row");

            foreach (XmlElement cell in MiiXml.ChildElements(row))
            {
                contract.Add(cell.LocalName, CsType.String, false);
            }

            return true;
        }

        public static bool IsRowsetDocument(string text)
        {
            XmlDocument document = MiiXml.TryParse(text);
            return document != null && document.DocumentElement != null && document.DocumentElement.LocalName == "Rowsets";
        }

        /// <summary>java.sql.Types codes as MII reports them in Column/@SQLDataType.</summary>
        public static CsType TypeOfSqlDataType(string code)
        {
            int value;

            if (!int.TryParse((code ?? string.Empty).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            {
                return CsType.String;
            }

            switch (value)
            {
                case -7:
                case 16:
                    return CsType.Bool;
                case -6:
                case 5:
                case 4:
                    return CsType.Int;
                case -5:
                    return CsType.Long;
                case 2:
                case 3:
                    return CsType.Decimal;
                case 6:
                case 7:
                case 8:
                    return CsType.Double;
                case 91:
                case 93:
                    return CsType.DateTime;
                default:
                    return CsType.String;
            }
        }

        /// <summary>The column types of an IlluminatorDocument column specification (STRING, NUMERIC, DATETIME, ...).</summary>
        public static CsType TypeOfColumnSpecification(string text)
        {
            string value = (text ?? string.Empty).Trim().ToUpperInvariant();

            if (value.StartsWith("NUM") || value == "DOUBLE" || value == "FLOAT" || value == "DECIMAL")
            {
                return CsType.Double;
            }

            if (value == "INTEGER" || value == "INT" || value == "LONG")
            {
                return CsType.Long;
            }

            if (value.StartsWith("DATE") || value == "TIMESTAMP")
            {
                return CsType.DateTime;
            }

            if (value.StartsWith("BOOL"))
            {
                return CsType.Bool;
            }

            return CsType.String;
        }
    }
}
