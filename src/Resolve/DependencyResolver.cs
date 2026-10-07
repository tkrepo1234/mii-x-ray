using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Xml;
using MiiXRay.Model;
using MiiXRay.Sources;

namespace MiiXRay.Resolve
{
    /// <summary>Everything one X-Ray run needs: the root transaction and every transaction and query it reaches.</summary>
    public sealed class ObjectGraph
    {
        public MiiTransaction Root;
        /// <summary>Transactions in discovery order (root first).</summary>
        public List<MiiTransaction> Transactions = new List<MiiTransaction>();
        public List<MiiQuery> Queries = new List<MiiQuery>();
        /// <summary>Referenced path (normalized) -> loaded transaction.</summary>
        public Dictionary<string, MiiTransaction> TransactionsByReference = new Dictionary<string, MiiTransaction>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, MiiQuery> QueriesByReference = new Dictionary<string, MiiQuery>(StringComparer.OrdinalIgnoreCase);
        /// <summary>Referenced paths that could not be loaded.</summary>
        public List<string> Missing = new List<string>();

        public MiiTransaction FindTransaction(string reference)
        {
            MiiTransaction transaction;
            return TransactionsByReference.TryGetValue(ObjectPath.Normalize(reference), out transaction) ? transaction : null;
        }

        public MiiQuery FindQuery(string reference)
        {
            MiiQuery query;
            return QueriesByReference.TryGetValue(ObjectPath.Normalize(reference), out query) ? query : null;
        }
    }

    /// <summary>Loads the root transaction and follows every static transaction and query reference recursively.</summary>
    public sealed class DependencyResolver
    {
        private static readonly Regex StringLiteral = new Regex("^\\s*\"([^\"\\\\]*)\"\\s*$", RegexOptions.Compiled);

        private readonly IObjectSource _source;
        private readonly ObjectGraph _graph = new ObjectGraph();
        private readonly Dictionary<string, object> _byCanonicalPath = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        private readonly Queue<MiiTransaction> _pending = new Queue<MiiTransaction>();

        public DependencyResolver(IObjectSource source)
        {
            _source = source;
        }

        /// <summary>Progress messages ("loaded X").</summary>
        public event Action<string> Progress;

        public ObjectGraph Resolve(string rootPath)
        {
            MiiTransaction root = LoadTransaction(rootPath);
            if (root == null)
            {
                return null;
            }
            _graph.Root = root;
            while (_pending.Count > 0)
            {
                MiiTransaction transaction = _pending.Dequeue();
                foreach (MiiActionDefinition action in transaction.Actions.Values)
                {
                    FollowAction(transaction, action);
                }
            }
            return _graph;
        }

        private void FollowAction(MiiTransaction owner, MiiActionDefinition action)
        {
            if (action.ActionType == "TransactionCall")
            {
                string name = action.Static("TransactionName");
                if (name.Length > 0)
                {
                    LoadTransaction(name);
                }
                return;
            }
            if (action.ActionType == "DynamicTransactionCall")
            {
                string name = LiteralLinkedValue(owner, action.Name, "TransactionName");
                if (name != null)
                {
                    LoadTransaction(name);
                }
                return;
            }
            if (action.HasProperty("QueryTemplate"))
            {
                string name = action.Static("QueryTemplate");
                if (name.Length == 0)
                {
                    name = LiteralLinkedValue(owner, action.Name, "QueryTemplate");
                }
                if (!string.IsNullOrEmpty(name))
                {
                    LoadQuery(name);
                }
            }
        }

        /// <summary>The value of an incoming link to Action.Property when it is a plain string literal; null otherwise.</summary>
        public static string LiteralLinkedValue(MiiTransaction owner, string actionName, string property)
        {
            foreach (MiiActionUse use in owner.AllActionUses())
            {
                if (use.Name != actionName)
                {
                    continue;
                }
                foreach (MiiLink link in use.Incoming)
                {
                    if (link.To == actionName + "." + property)
                    {
                        Match match = StringLiteral.Match(link.From);
                        return match.Success ? match.Groups[1].Value : null;
                    }
                }
            }
            return null;
        }

        private MiiTransaction LoadTransaction(string reference)
        {
            string key = ObjectPath.Normalize(reference);
            MiiTransaction known;
            if (_graph.TransactionsByReference.TryGetValue(key, out known))
            {
                return known;
            }
            if (_graph.Missing.Contains(key))
            {
                return null;
            }
            object loaded = LoadObject(key);
            MiiTransaction transaction = loaded as MiiTransaction;
            if (transaction == null)
            {
                Remember(key, loaded);
                return null;
            }
            _graph.TransactionsByReference[key] = transaction;
            return transaction;
        }

        private void LoadQuery(string reference)
        {
            string key = ObjectPath.Normalize(reference);
            if (_graph.QueriesByReference.ContainsKey(key) || _graph.TransactionsByReference.ContainsKey(key) || _graph.Missing.Contains(key))
            {
                return;
            }
            object loaded = LoadObject(key);
            MiiQuery query = loaded as MiiQuery;
            if (query == null)
            {
                Remember(key, loaded);
                return;
            }
            _graph.QueriesByReference[key] = query;
            if (query.Kind == MiiQueryKind.Xacute && query.XacuteTransaction.Length > 0)
            {
                LoadTransaction(query.XacuteTransaction);
            }
        }

        private void Remember(string key, object loaded)
        {
            MiiTransaction transaction = loaded as MiiTransaction;
            if (transaction != null)
            {
                _graph.TransactionsByReference[key] = transaction;
                return;
            }
            MiiQuery query = loaded as MiiQuery;
            if (query != null)
            {
                _graph.QueriesByReference[key] = query;
                return;
            }
            if (loaded == null && !_graph.Missing.Contains(key))
            {
                _graph.Missing.Add(key);
            }
        }

        /// <summary>Loads and parses one object; the same file reached by two different references is parsed once.</summary>
        private object LoadObject(string key)
        {
            LoadedObject loaded = _source.Load(key);
            if (loaded == null)
            {
                Report("not found: " + key);
                return null;
            }
            object existing;
            if (_byCanonicalPath.TryGetValue(loaded.CanonicalPath, out existing))
            {
                return existing;
            }
            XmlDocument document;
            try
            {
                document = MiiXml.Parse(loaded.Text);
            }
            catch (XmlException exception)
            {
                Report("not readable (" + exception.Message + "): " + key);
                return null;
            }
            object result;
            if (ObjectReader.IsTransaction(document))
            {
                MiiTransaction transaction = ObjectReader.ReadTransaction(key, document);
                _graph.Transactions.Add(transaction);
                _pending.Enqueue(transaction);
                result = transaction;
            }
            else
            {
                MiiQuery query = ObjectReader.ReadQuery(key, document);
                _graph.Queries.Add(query);
                result = query;
            }
            _byCanonicalPath[loaded.CanonicalPath] = result;
            Report("loaded " + key);
            return result;
        }

        private void Report(string message)
        {
            Action<string> handler = Progress;
            if (handler != null)
            {
                handler(message);
            }
        }
    }
}
