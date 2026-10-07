using MiiXRay.Expressions;
using MiiXRay.Generate;

namespace MiiXRay.Tests
{
    public static class ExpressionTests
    {
        /// <summary>Resolves Transaction.Site/Count/Flag and Local.Map for the translator tests.</summary>
        private sealed class Symbols : ISymbolResolver
        {
            public TypedCode Resolve(ReferenceNode reference)
            {
                switch (reference.Path)
                {
                    case "Transaction.Site": return TypedCode.Primary("request.Site", CsType.String);
                    case "Transaction.Count": return TypedCode.Primary("request.Count", CsType.Int);
                    case "Transaction.Flag": return TypedCode.Primary("request.Flag", CsType.Bool);
                    case "Local.Map": return TypedCode.Primary("map", CsType.Map);
                    case "Local.Doc": return TypedCode.Primary("doc", CsType.Xml);
                    default: return null;
                }
            }

            public void Note(string message)
            {
            }
        }

        private static string Translate(string expression)
        {
            return new ExpressionTranslator(new Symbols()).Translate(expression).Code;
        }

        public static void ConcatenationBindsTighterThanComparison()
        {
            BinaryNode node = (BinaryNode)Parser.Parse("\"a\" & \"b\" == \"ab\"");
            Assert.Equal("==", node.Operator);
            Assert.Equal("&", ((BinaryNode)node.Left).Operator);
        }

        public static void EqualityBindsWeakerThanAnd()
        {
            BinaryNode node = (BinaryNode)Parser.Parse("a.b == c.d && e.f");
            Assert.Equal("==", node.Operator);
            Assert.Equal("&&", ((BinaryNode)node.Right).Operator);
        }

        public static void WordOperatorsAndFunctions()
        {
            Assert.Equal("&&", ((BinaryNode)Parser.Parse("x.a and x.b")).Operator);
            Assert.True(Parser.Parse("and(x.a, x.b)") is FunctionNode, "and(...) is the function");
        }

        public static void SelectorKeepsQuotesAndBrackets()
        {
            ReferenceNode node = (ReferenceNode)Parser.Parse("Q.Results{/Rowsets/Rowset/Row[Name = '}']/Value}");
            Assert.Equal("/Rowsets/Rowset/Row[Name = '}']/Value", node.Selector);
        }

        public static void CommentOnlyIsEmpty()
        {
            Assert.True(Parser.Parse("/* nothing */") is EmptyNode, "a comment alone is an empty expression");
        }

        public static void StringConcatenationIsNative()
        {
            Assert.Equal("\"Site \" + request.Site + \" has \" + request.Count", Translate("\"Site \" & Transaction.Site & \" has \" & Transaction.Count"));
        }

        public static void EmptyStringIsDroppedFromConcatenation()
        {
            Assert.Equal("Mii.ToStr(request.Count)", Translate("Transaction.Count & \"\""));
        }

        public static void MatchIsCaseSensitiveRegex()
        {
            Assert.Equal("Regex.IsMatch(request.Site, \"^M$\")", Translate("match(Transaction.Site, \"^M$\")"));
        }

        public static void StringIfBecomesConditional()
        {
            Assert.Equal("request.Flag ? \"yes\" : \"no\"", Translate("stringif(Transaction.Flag, \"yes\", \"no\")"));
        }

        public static void MixedEqualityUsesHelper()
        {
            Assert.Equal("Mii.AreEqual(request.Site, 1)", Translate("Transaction.Site == 1"));
            Assert.Equal("request.Site == \"M\"", Translate("Transaction.Site == \"M\""));
        }

        public static void DivisionIsNotInteger()
        {
            Assert.Equal("(double)request.Count / 2", Translate("Transaction.Count / 2"));
        }

        public static void MapAndXmlSelectors()
        {
            Assert.Equal("Mii.MapGet(map, \"Key\")", Translate("Local.Map{Key}"));
            Assert.Equal("Mii.XPath(doc, \"/a/b\")", Translate("Local.Doc{/a/b}"));
        }

        public static void KeywordsAndUnknownFunctions()
        {
            Assert.Equal("TransactionPath", Translate("transactionpath"));
            Assert.Contains("Mii.Function(\"nosuchfunction\"", Translate("nosuchfunction(1)"));
        }

        public static void UnknownReferenceStillCompiles()
        {
            Assert.Equal("Mii.Unresolved(\"Transaction.Missing\")", Translate("Transaction.Missing"));
        }

        public static void InterpolationInStrings()
        {
            Assert.Equal("\"Site: \" + request.Site", Translate("\"Site: #Transaction.Site#\""));
            Assert.Equal("\"[\\\\*#]$\"", Translate("\"[\\\\*#]$\""));
        }
    }
}
