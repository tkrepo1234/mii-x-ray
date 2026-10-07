using System.Collections.Generic;

namespace MiiXRay.Model
{
    public enum MiiQueryKind
    {
        Sql,
        Mdo,
        Xml,
        Xacute,
        Other
    }

    public sealed class MiiQueryParameter
    {
        public int Slot;
        public string Description;
        /// <summary>String, Integer, Timestamp, Boolean or empty.</summary>
        public string Type;
        public string DefaultValue;
    }

    /// <summary>A query template (.tqsq, .tqmd, .tqxm, .tqxc).</summary>
    public sealed class MiiQuery
    {
        public string Path;
        public MiiQueryKind Kind;
        /// <summary>Root element name: SQLQuery, MDOQuery, XMLQuery, XacuteQuery, ...</summary>
        public string RootName;
        /// <summary>FixedQuery, Command, Select, Insert, ... (query mode).</summary>
        public string Mode;
        /// <summary>SQL text (SQL) or a readable statement built from the MDO settings.</summary>
        public string Text;
        public string Url;
        /// <summary>Parameter slots that have a description, a default or occur in the text, ordered by slot.</summary>
        public List<MiiQueryParameter> Parameters = new List<MiiQueryParameter>();

        // Xacute query: forwards to a transaction
        public string XacuteTransaction;
        public string XacuteOutputParameter;
        public Dictionary<int, string> XacuteMappedTargets = new Dictionary<int, string>();

        public string ShortName
        {
            get
            {
                int slash = Path.LastIndexOf('/');
                return slash >= 0 ? Path.Substring(slash + 1) : Path;
            }
        }

        public MiiQueryParameter FindParameter(int slot)
        {
            foreach (MiiQueryParameter parameter in Parameters)
            {
                if (parameter.Slot == slot)
                {
                    return parameter;
                }
            }
            return null;
        }
    }
}
