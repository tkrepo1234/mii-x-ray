using System.Collections.Generic;
using System.Xml;

namespace MiiXRay.Model
{
    /// <summary>A transaction property (input, output or local variable).</summary>
    public sealed class MiiParameter
    {
        public string Name;
        /// <summary>MII value type: string, boolean, integer, long, double, float, dateTime, list, map, xml, ...</summary>
        public string Type;
        /// <summary>The default value as text (for xml: the document text).</summary>
        public string DefaultText;
        public string Description;
        /// <summary>For xml values: the variable whose document is the reference (e.g. Local.SfcsReference), or "".</summary>
        public string ReferenceSource;
        public bool IsOutput;
    }

    /// <summary>One link (Assign element) of an action.</summary>
    public sealed class MiiLink
    {
        /// <summary>Assign, AssignXml, RemoveXml, AppendXml, AppendAfterXml, ReplaceXml.</summary>
        public string Kind;
        public string From;
        public string To;
    }

    /// <summary>An action definition (Actions/ContextItem): the action class and its configured properties.</summary>
    public sealed class MiiActionDefinition
    {
        public string Name;
        public string ActionType;
        public XmlElement Value;

        public XmlElement Property(string name)
        {
            return MiiXml.Child(Value, name);
        }

        public bool HasProperty(string name)
        {
            return Property(name) != null;
        }

        /// <summary>The configured value of a property: its own text, trimmed ("" when missing).</summary>
        public string Static(string name)
        {
            return MiiXml.OwnText(Property(name)).Trim();
        }
    }

    /// <summary>The use of an action inside a step, with its links.</summary>
    public sealed class MiiActionUse
    {
        public string Name;
        public List<MiiLink> Incoming = new List<MiiLink>();
        public List<MiiLink> Outgoing = new List<MiiLink>();
        public MiiActionDefinition Definition;
    }

    /// <summary>A node of the flow chart: at most one action and the child steps.</summary>
    public sealed class MiiStep
    {
        /// <summary>ActionSequence, Conditional, Switcher, Iterator, Repeater, ForNextRepeater, Catch, ...</summary>
        public string StepType;
        public string Name;
        public MiiActionUse Action;
        public List<MiiStep> Children = new List<MiiStep>();
    }

    public sealed class MiiTransaction
    {
        /// <summary>The logical path the object was loaded by (without extension).</summary>
        public string Path;
        public string Description;
        public List<MiiParameter> Inputs = new List<MiiParameter>();
        public List<MiiParameter> Outputs = new List<MiiParameter>();
        public List<MiiParameter> Locals = new List<MiiParameter>();
        public Dictionary<string, MiiActionDefinition> Actions = new Dictionary<string, MiiActionDefinition>();
        public List<MiiStep> Steps = new List<MiiStep>();

        public string ShortName
        {
            get
            {
                int slash = Path.LastIndexOf('/');
                return slash >= 0 ? Path.Substring(slash + 1) : Path;
            }
        }

        /// <summary>Every action use of the step tree in execution (pre-)order.</summary>
        public List<MiiActionUse> AllActionUses()
        {
            List<MiiActionUse> result = new List<MiiActionUse>();

            foreach (MiiStep step in Steps)
            {
                Collect(step, result);
            }

            return result;
        }

        private static void Collect(MiiStep step, List<MiiActionUse> result)
        {
            if (step.Action != null)
            {
                result.Add(step.Action);
            }

            foreach (MiiStep child in step.Children)
            {
                Collect(child, result);
            }
        }
    }
}
