using System.Collections.Generic;
using MiiXRay.Generate;
using MiiXRay.Sources;

namespace MiiXRay.Tests
{
    public static class ModelTests
    {
        public static void SqlColumnsFromAliasesAndDottedNames()
        {
            List<string> columns = SqlColumns.Extract("select s.SFC as \"Sfc\", s.ITEM, count(*) Total, 'x' || y from SFC s where a = '[Param.1]'");
            Assert.Equal("Sfc,ITEM,Total", string.Join(",", columns.ToArray()));
        }

        public static void SqlColumnsOfLastSelectInBlock()
        {
            List<string> columns = SqlColumns.Extract("do begin declare x int; select 1 into x from dummy; select \"A\", b as \"B\" from t; end");
            Assert.Equal("A,B", string.Join(",", columns.ToArray()));
        }

        public static void SqlColumnsWithCte()
        {
            List<string> columns = SqlColumns.Extract("with c as (select a from t) select c.a as \"Value\" from c");
            Assert.Equal("Value", string.Join(",", columns.ToArray()));
        }

        public static void ListAndMapLiterals()
        {
            Assert.Equal("Mii.List(\"a\", \"b c\")", ValueLiteral.ListCode("[[string:a], [string:b c]]"));
            Assert.Equal("Mii.Map(\"K\", \"v\", \"N\", \"1.0\")", ValueLiteral.MapCode("{K=[string:v], N=[double:1.0]}"));
        }

        public static void ObjectPathsWithAndWithoutExtension()
        {
            Assert.Equal("P/F/trxLoad", ObjectPath.Normalize("/P\\F/trxLoad.trx"));
            Assert.Equal("P/F/trxLoad", ObjectPath.Normalize("P/F/trxLoad"));
        }

        public static void NamingAvoidsKeywordsAndDigits()
        {
            Assert.Equal("classValue", Naming.Camel("class"));
            Assert.Equal("_1Value", Naming.Sanitize("1Value"));
            Assert.Equal("sfcNumber", Naming.Camel("SFCNumber"));
        }

        public static void TentativeColumnTakesTheUsedSpelling()
        {
            RowsetContract contract = new RowsetContract("Row", "test");
            contract.Add("SFC", CsType.String, true);
            contract.Ensure("Sfc");
            Assert.Equal(1, contract.Columns.Count);
            Assert.Equal("Sfc", contract.Columns[0].Name);
        }
    }
}
