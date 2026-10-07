using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using MiiXRay.Expressions;
using MiiXRay.Model;
using MiiXRay.Resolve;

namespace MiiXRay.Generate
{
    /// <summary>Generates the Execute method of one transaction: the step tree becomes C# control flow, the actions
    /// become calls, the links become assignments. This file holds the symbols (what a reference means in C#);
    /// the step, action and link translation live in the other parts of the class.</summary>
    public sealed partial class TransactionEmitter : ISymbolResolver
    {
        private enum ActionKind
        {
            None,
            TransactionCall,
            Query,
            QueryCommand,
            Xacute,
            Plugin,
            Catch,
            Document,
            Xml,
            Loop
        }

        private sealed class ActionSymbol
        {
            public string Name;
            public MiiActionDefinition Definition;
            public ActionKind Kind;
            /// <summary>The variable holding the action's result, or null when nothing reads it.</summary>
            public string Variable;
            public CsType VariableType;
            public string Initializer;
            public TransactionContract Callee;
            public QueryContract Query;
            public RowsetContract Document;
        }

        private sealed class LoopScope
        {
            public string ActionName;
            public string ActionType;
            public TypedCode Item;
            public TypedCode Index;
            public TypedCode Count;
            public string BreakVariable;
        }

        private static readonly string[] LoopTypes = { "IteratorAction", "RepeaterAction", "ForNextRepeaterAction", "WhileRepeaterAction" };

        /// <summary>Property scopes of the MII server and project (shared memory, global properties).</summary>
        private static readonly string[] SharedScopes = { "Inline", "Persistent", "Global", "Shared" };

        private readonly GenerationContext _context;
        private readonly TransactionContract _contract;
        private readonly MiiTransaction _transaction;
        private readonly ExpressionTranslator _translator;
        private readonly UniqueNames _names = new UniqueNames();
        private readonly Dictionary<string, ActionSymbol> _actions = new Dictionary<string, ActionSymbol>();
        private readonly List<LoopScope> _loops = new List<LoopScope>();
        private readonly List<string> _expressionTexts = new List<string>();
        private string _currentAction = string.Empty;

        public TransactionEmitter(GenerationContext context, TransactionContract contract)
        {
            _context = context;
            _contract = contract;
            _transaction = contract.Transaction;
            _translator = new ExpressionTranslator(this);
            foreach (string reserved in new string[] { "request", "response", "queryService", "pluginService" })
            {
                _names.Reserve(reserved);
            }
            foreach (PropertySpec local in contract.Locals)
            {
                _names.Reserve(local.Name);
            }
            CollectExpressionTexts();
            foreach (MiiActionDefinition definition in _transaction.Actions.Values)
            {
                _actions[definition.Name] = CreateSymbol(definition);
            }
        }

        /// <summary>Every text that can reference an action: link expressions and targets, configured loop sources and documents.</summary>
        private void CollectExpressionTexts()
        {
            foreach (MiiActionUse use in _transaction.AllActionUses())
            {
                foreach (MiiLink link in use.Incoming)
                {
                    _expressionTexts.Add(link.From);
                    _expressionTexts.Add(link.To);
                }
                foreach (MiiLink link in use.Outgoing)
                {
                    _expressionTexts.Add(link.From);
                    _expressionTexts.Add(link.To);
                }
            }
            foreach (MiiActionDefinition definition in _transaction.Actions.Values)
            {
                foreach (string property in new string[] { "Source", "IlluminatorDocument", "From", "To", "Step" })
                {
                    if (definition.HasProperty(property))
                    {
                        _expressionTexts.Add(definition.Static(property));
                    }
                }
            }
        }

        private bool IsReferenced(string actionName, string member)
        {
            Regex pattern = new Regex(@"(?<![A-Za-z0-9_.])" + Regex.Escape(actionName) + @"\." + (member == null ? string.Empty : Regex.Escape(member) + @"(?![A-Za-z0-9_])"));
            foreach (string text in _expressionTexts)
            {
                if (text != null && pattern.IsMatch(text))
                {
                    return true;
                }
            }
            return false;
        }

        private bool IsLinkTarget(string actionName, string member)
        {
            foreach (MiiActionUse use in _transaction.AllActionUses())
            {
                foreach (MiiLink link in use.Outgoing)
                {
                    if (link.To == actionName + "." + member)
                    {
                        return true;
                    }
                }
                foreach (MiiLink link in use.Incoming)
                {
                    if (link.To == actionName + "." + member && use.Name != actionName)
                    {
                        return true;
                    }
                }
            }
            return false;
        }

        private ActionSymbol CreateSymbol(MiiActionDefinition definition)
        {
            ActionSymbol symbol = new ActionSymbol();
            symbol.Name = definition.Name;
            symbol.Definition = definition;
            symbol.Kind = KindOf(definition, symbol);
            bool hasResult = symbol.Kind != ActionKind.None && symbol.Kind != ActionKind.Loop && symbol.Kind != ActionKind.QueryCommand;
            if (!hasResult || !IsReferenced(definition.Name, null))
            {
                return symbol;
            }
            symbol.Variable = _names.Claim(Naming.Camel(definition.Name));
            switch (symbol.Kind)
            {
                case ActionKind.TransactionCall:
                case ActionKind.Xacute:
                    symbol.VariableType = CsType.Class(symbol.Callee.ClassName + ".Response");
                    symbol.Initializer = "new " + symbol.Callee.ClassName + ".Response()";
                    break;
                case ActionKind.Query:
                    symbol.VariableType = CsType.RowsetOf(symbol.Query.Result);
                    symbol.Initializer = "new " + symbol.VariableType.Name + "()";
                    break;
                case ActionKind.Catch:
                    symbol.VariableType = CsType.Class("Exception");
                    symbol.Initializer = "null";
                    break;
                case ActionKind.Document:
                    symbol.VariableType = CsType.RowsetOf(symbol.Document);
                    symbol.Initializer = "new " + symbol.VariableType.Name + "()";
                    break;
                case ActionKind.Xml:
                    symbol.VariableType = CsType.Xml;
                    symbol.Initializer = "new XmlDocument()";
                    break;
                default:
                    symbol.VariableType = CsType.Class("PluginResult");
                    symbol.Initializer = "new PluginResult()";
                    break;
            }
            return symbol;
        }

        private ActionKind KindOf(MiiActionDefinition definition, ActionSymbol symbol)
        {
            string type = definition.ActionType;
            if (Array.IndexOf(LoopTypes, type) >= 0)
            {
                return ActionKind.Loop;
            }
            switch (type)
            {
                case "Assignment":
                case "ConditionalAction":
                case "SwitcherAction":
                case "Throw":
                case "TerminateTransaction":
                case "Tracer":
                case "EventLogger":
                case "Pause":
                case "IlluminatorRow":
                    return ActionKind.None;
                case "CatchAction":
                    return ActionKind.Catch;
                case "StringToXmlConverter":
                case "XSLTransform":
                    return ActionKind.Xml;
                case "IlluminatorDocument":
                    symbol.Document = DocumentContract(definition);
                    return ActionKind.Document;
                case "TransactionCall":
                    symbol.Callee = _context.FindTransaction(definition.Static("TransactionName"));
                    return symbol.Callee != null ? ActionKind.TransactionCall : ActionKind.Plugin;
                case "DynamicTransactionCall":
                    string literal = DependencyResolver.LiteralLinkedValue(_transaction, definition.Name, "TransactionName");
                    symbol.Callee = literal == null ? null : _context.FindTransaction(literal);
                    return symbol.Callee != null ? ActionKind.TransactionCall : ActionKind.Plugin;
            }
            if (definition.HasProperty("QueryTemplate"))
            {
                string template = definition.Static("QueryTemplate");
                if (template.Length == 0)
                {
                    template = DependencyResolver.LiteralLinkedValue(_transaction, definition.Name, "QueryTemplate") ?? string.Empty;
                }
                symbol.Query = _context.FindQuery(template);
                if (symbol.Query == null)
                {
                    return ActionKind.Plugin;
                }
                if (symbol.Query.Query.Kind == MiiQueryKind.Xacute)
                {
                    symbol.Callee = symbol.Query.XacuteTarget;
                    return symbol.Callee != null ? ActionKind.Xacute : ActionKind.Plugin;
                }
                if (symbol.Query.Result == null)
                {
                    return ActionKind.Plugin;
                }
                return string.Equals(symbol.Query.Query.Mode, "Command", StringComparison.OrdinalIgnoreCase) ? ActionKind.QueryCommand : ActionKind.Query;
            }
            return ActionKind.Plugin;
        }

        private RowsetContract DocumentContract(MiiActionDefinition definition)
        {
            RowsetContract contract = _contract.CreateNestedContract(definition.Name, "column specification of " + definition.Name);
            foreach (System.Xml.XmlElement column in MiiXml.Children(definition.Property("ColumnSpecifications"), "ContextItem"))
            {
                string name = MiiXml.ChildText(column, "Name").Trim();
                if (name.Length > 0)
                {
                    contract.Add(name, ContractFactory.TypeOfColumnSpecification(MiiXml.OwnText(MiiXml.Child(column, "Value"))), false);
                }
            }
            return _contract.ShareIdentical(contract);
        }

        // ------------------------------------------------------------------ ISymbolResolver

        public void Note(string message)
        {
            _context.Note(_transaction.ShortName + (_currentAction.Length > 0 ? "/" + _currentAction : string.Empty), message);
        }

        public TypedCode Resolve(ReferenceNode reference)
        {
            string scope = reference.Scope;
            string member = reference.Member;
            if (scope == "Transaction")
            {
                PropertySpec input = _contract.FindInput(member);
                if (input != null)
                {
                    return TypedCode.Primary("request." + input.Name, input.Type);
                }
                PropertySpec output = _contract.FindOutput(member);
                return output == null ? null : TypedCode.Primary("response." + output.Name, output.Type);
            }
            if (scope == "Local")
            {
                PropertySpec local = _contract.FindLocal(member);
                return local == null ? null : TypedCode.Primary(local.Name, local.Type);
            }
            if (Array.IndexOf(SharedScopes, scope) >= 0)
            {
                return TypedCode.Primary("pluginService.GetProperty(" + CsLiteral.String(reference.Path) + ")", CsType.Object);
            }
            LoopScope loop = FindLoop(scope);
            if (loop != null)
            {
                return ResolveLoopMember(loop, member);
            }
            ActionSymbol symbol;
            if (!_actions.TryGetValue(scope, out symbol))
            {
                return null;
            }
            if (symbol.Kind == ActionKind.Loop)
            {
                Note(reference.Path + " is used outside its loop");
                return _translator.Unresolved(reference.Path);
            }
            TypedCode result = ResolveActionMember(symbol, member) ?? ConfiguredValue(symbol, member);
            if (result == null)
            {
                Note("the action output " + reference.Path + " has no C# equivalent");
                return _translator.Unresolved(reference.Path);
            }
            return result;
        }

        private LoopScope FindLoop(string actionName)
        {
            for (int index = _loops.Count - 1; index >= 0; index--)
            {
                if (_loops[index].ActionName == actionName)
                {
                    return _loops[index];
                }
            }
            return null;
        }

        private TypedCode ResolveLoopMember(LoopScope loop, string member)
        {
            switch (member)
            {
                case "Item":
                case "Output":
                    return loop.Item;
                case "CurrentItem":
                    return loop.ActionType == "IteratorAction" ? loop.Item : loop.Index;
                case "ItemCount":
                    return loop.Count;
                case "Break":
                    return loop.BreakVariable != null ? TypedCode.Primary(loop.BreakVariable, CsType.Bool) : TypedCode.Primary("false", CsType.Bool);
                default:
                    return null;
            }
        }

        private TypedCode ResolveActionMember(ActionSymbol symbol, string member)
        {
            if (symbol.Variable == null)
            {
                return null;
            }
            TypedCode variable = TypedCode.Primary(symbol.Variable, symbol.VariableType);
            switch (symbol.Kind)
            {
                case ActionKind.TransactionCall:
                    PropertySpec output = symbol.Callee.FindOutput(member);
                    return output == null ? null : TypedCode.Primary(symbol.Variable + "." + output.Name, output.Type);
                case ActionKind.Xacute:
                    if (member != "Results")
                    {
                        return null;
                    }
                    PropertySpec returned = symbol.Callee.FindOutput(symbol.Query.Query.XacuteOutputParameter);
                    return returned == null ? variable : TypedCode.Primary(symbol.Variable + "." + returned.Name, returned.Type);
                case ActionKind.Query:
                    if (member == "Results")
                    {
                        return variable;
                    }
                    return member == "ResultsAsString" ? TypedCode.Primary("Mii.ToStr(" + symbol.Variable + ")", CsType.String) : null;
                case ActionKind.Catch:
                    return CatchMember(symbol.Variable, member);
                case ActionKind.Document:
                    return member == "Output" ? variable : null;
                case ActionKind.Xml:
                    if (member == "Output")
                    {
                        return variable;
                    }
                    return member == "TextOutput" ? TypedCode.Primary("Mii.ToStr(" + symbol.Variable + ")", CsType.String) : null;
                case ActionKind.Plugin:
                    return TypedCode.Primary(symbol.Variable + ".Get(" + CsLiteral.String(member) + ")", CsType.Object);
                default:
                    return null;
            }
        }

        /// <summary>Reading a property the action only configures (e.g. a query's DateFormat): its configured value.</summary>
        private static TypedCode ConfiguredValue(ActionSymbol symbol, string member)
        {
            System.Xml.XmlElement property = symbol.Definition.Property(member);
            if (property == null || MiiXml.ChildElements(property).Count > 0)
            {
                return null;
            }
            TypedCode value = TypedCode.Primary(CsLiteral.String(MiiXml.OwnText(property).Trim()), CsType.String);
            value.IsLiteral = true;
            value.LiteralText = MiiXml.OwnText(property).Trim();
            return value;
        }

        private static TypedCode CatchMember(string variable, string member)
        {
            switch (member)
            {
                case "Message":
                    return TypedCode.Primary("Mii.ExceptionMessage(" + variable + ")", CsType.String);
                case "ExceptionType":
                    return TypedCode.Primary("Mii.ExceptionType(" + variable + ")", CsType.String);
                case "Source":
                    return TypedCode.Primary("Mii.ExceptionSource(" + variable + ")", CsType.String);
                case "ActionType":
                    return TypedCode.Primary("Mii.ExceptionActionType(" + variable + ")", CsType.String);
                case "ExceptionCaught":
                    return new TypedCode(variable + " != null", CsType.Bool, Precedence.Equality);
                case "Succeeded":
                    return TypedCode.Primary("true", CsType.Bool);
                default:
                    return null;
            }
        }
    }
}
