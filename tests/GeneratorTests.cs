using System;
using System.CodeDom.Compiler;
using System.IO;
using System.Reflection;
using System.Text;
using Microsoft.CSharp;
using MiiXRay.Generate;
using MiiXRay.Resolve;
using MiiXRay.Sources;

namespace MiiXRay.Tests
{
    /// <summary>End to end: an export folder with a small transaction and a query, X-Rayed, compiled and run.</summary>
    public static class GeneratorTests
    {
        private const string Transaction =
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
            "<Transaction Version=\"15.5.1.23\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">" +
            "<Name>DEMO/trxCheckSite</Name>" +
            "<Context>" +
            "<ContextItem><Name>Site</Name><Value xsi:type=\"string\">M</Value><ReadOnly>false</ReadOnly></ContextItem>" +
            "<ContextItem><Name>Message</Name><Value xsi:type=\"string\"/><ReadOnly>true</ReadOnly></ContextItem>" +
            "<ContextItem><Name>Sfcs</Name><Value xsi:type=\"xml\"><ReferenceDocumentSource/>&lt;Rowsets&gt;&lt;Rowset&gt;&lt;Columns&gt;&lt;Column Name=\"Sfc\"/&gt;&lt;/Columns&gt;&lt;/Rowset&gt;&lt;/Rowsets&gt;</Value><ReadOnly>true</ReadOnly></ContextItem>" +
            "</Context><Local/>" +
            "<Actions>" +
            "<ContextItem><Name>SiteIsEmpty</Name><Value xsi:type=\"ConditionalAction\"><InputCount>1</InputCount><LogicalAnd>true</LogicalAnd></Value></ContextItem>" +
            "<ContextItem><Name>ThrowEmptySite</Name><Value xsi:type=\"Throw\"><Message>The site is empty</Message></Value></ContextItem>" +
            "<ContextItem><Name>SelectSfcs</Name><Value xsi:type=\"IlluminatorSQLQueryObject\"><QueryTemplate>DEMO/sqlSelectSfcs</QueryTemplate></Value></ContextItem>" +
            "<ContextItem><Name>AssignOutputs</Name><Value xsi:type=\"Assignment\"/></ContextItem>" +
            "<ContextItem><Name>CatchAll</Name><Value xsi:type=\"CatchAction\"/></ContextItem>" +
            "<ContextItem><Name>TerminateWithError</Name><Value xsi:type=\"TerminateTransaction\"><TerminateWithError>true</TerminateWithError></Value></ContextItem>" +
            "</Actions>" +
            "<Steps><Step xsi:type=\"ActionSequence\"><Name>Sequence</Name><Steps>" +
            "<Step xsi:type=\"Conditional\"><Name>Sequence_1</Name><Steps>" +
            "<Step xsi:type=\"ActionSequence\"><Name>Sequence_2</Name><Actions><Action><Name>ThrowEmptySite</Name></Action></Actions></Step>" +
            "</Steps><Actions><Action><Name>SiteIsEmpty</Name><IncomingLinks><Assign xsi:type=\"Assign\"><From>match(Transaction.Site, \"^\\\\s*$\")</From><To>SiteIsEmpty.Input1</To></Assign></IncomingLinks></Action></Actions></Step>" +
            "<Step xsi:type=\"ActionSequence\"><Name>Sequence_3</Name><Actions><Action><Name>SelectSfcs</Name><IncomingLinks><Assign xsi:type=\"Assign\"><From>Transaction.Site</From><To>SelectSfcs.Param.1</To></Assign></IncomingLinks></Action></Actions></Step>" +
            "<Step xsi:type=\"ActionSequence\"><Name>Sequence_4</Name><Actions><Action><Name>AssignOutputs</Name><OutgoingLinks>" +
            "<Assign xsi:type=\"Assign\"><From>\"Site \" &amp; Transaction.Site &amp; \": \" &amp; SelectSfcs.Results{count(/Rowsets/Rowset/Row)} &amp; \" SFC, first \" &amp; SelectSfcs.Results{/Rowsets/Rowset/Row/Sfc}</From><To>Transaction.Message</To></Assign>" +
            "<Assign xsi:type=\"AssignXml\"><From>SelectSfcs.Results</From><To>Transaction.Sfcs</To></Assign>" +
            "</OutgoingLinks></Action></Actions></Step>" +
            "<Step xsi:type=\"Catch\"><Name>Sequence_5</Name><Steps>" +
            "<Step xsi:type=\"ActionSequence\"><Name>Sequence_6</Name><Actions><Action><Name>TerminateWithError</Name><IncomingLinks><Assign xsi:type=\"Assign\"><From>\"Failed: \" &amp; CatchAll.Message</From><To>TerminateWithError.TerminationMessage</To></Assign></IncomingLinks></Action></Actions></Step>" +
            "</Steps><Actions><Action><Name>CatchAll</Name></Action></Actions></Step>" +
            "</Steps></Step></Steps></Transaction>";

        private const string Query =
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><SQLQuery Mode=\"FixedQuery\" Query=\"select SFC as &quot;Sfc&quot; from SFC where SITE = '[Param.1]'\" " +
            "ParamDescription.1=\"Site\" Param.1=\"\"><Tasks/></SQLQuery>";

        private const string Runner =
            "namespace XRay.TrxCheckSiteLogic {" +
            "  public sealed class FakeQueries : IQueryService {" +
            "    public T ExecuteQuery<T>(string text, IQueryRequest request) where T : RowsetCore, new() {" +
            "      T result = new T();" +
            "      result.LoadXml(Mii.ParseXml(\"<Rowsets><Rowset><Row><Sfc>S1-\" + request.GetParameters()[\"Param.1\"] + \"</Sfc></Row><Row><Sfc>S2</Sfc></Row></Rowset></Rowsets>\"));" +
            "      return result; }" +
            "    public void ExecuteCommand(string text, IQueryRequest request) { } }" +
            "  public static class Run {" +
            "    public static string Check(string site) {" +
            "      TrxCheckSite.Request request = new TrxCheckSite.Request(); request.Site = site;" +
            "      try { TrxCheckSite.Response response = TrxCheckSite.Execute(request, new FakeQueries(), null);" +
            "        return response.Message + \" | \" + response.Sfcs.Rows.Count; }" +
            "      catch (TransactionTerminatedException e) { return \"terminated: \" + e.Message; } } } }";

        private static string Generate()
        {
            string folder = Path.Combine(Path.GetTempPath(), "mii-x-ray-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path.Combine(folder, "DEMO"));

            try
            {
                File.WriteAllText(Path.Combine(folder, "DEMO\\trxCheckSite.trx"), Transaction, Encoding.UTF8);
                File.WriteAllText(Path.Combine(folder, "DEMO\\sqlSelectSfcs.tqsq"), Query, Encoding.UTF8);
                ObjectGraph graph = new DependencyResolver(new FolderSource(folder)).Resolve("DEMO/trxCheckSite");
                return CodeFile.Generate(graph, "test").Code;
            }
            finally
            {
                Directory.Delete(folder, true);
            }
        }

        public static void TranslatesTheFlow()
        {
            string code = Generate();
            Assert.Contains("if (Regex.IsMatch(request.Site, \"^\\\\s*$\"))", code);
            Assert.Contains("throw new MiiException(\"The site is empty\", \"ThrowEmptySite\");", code);
            Assert.Contains("SqlSelectSfcs.Result selectSfcs = queryService.ExecuteQuery<SqlSelectSfcs.Result>(SqlSelectSfcs.Text, new SqlSelectSfcs.Request(site: request.Site));", code);
            Assert.NotContains("Action results", code);
            Assert.Contains("selectSfcs.Rows.Count", code);
            Assert.Contains("selectSfcs.FirstRow.Sfc", code);
            Assert.Contains("catch (Exception catchAll)", code);
            Assert.Contains("\"Failed: \" + Mii.ExceptionMessage(catchAll)", code);
            Assert.Contains("public string Sfc { get; set; }", code);
        }

        public static void CompilesAndRuns()
        {
            CSharpCodeProvider provider = new CSharpCodeProvider();
            CompilerParameters parameters = new CompilerParameters(new string[] { "System.dll", "System.Xml.dll" });
            parameters.GenerateInMemory = true;
            parameters.CompilerOptions = "/langversion:5";
            CompilerResults results = provider.CompileAssemblyFromSource(parameters, Generate(), Runner);

            if (results.Errors.HasErrors)
            {
                StringBuilder errors = new StringBuilder();

                foreach (CompilerError error in results.Errors)
                {
                    errors.AppendLine(error.ToString());
                }

                throw new Exception(errors.ToString());
            }

            MethodInfo check = results.CompiledAssembly.GetType("XRay.TrxCheckSiteLogic.Run").GetMethod("Check");
            Assert.Equal("Site M: 2 SFC, first S1-M | 2", check.Invoke(null, new object[] { "M" }));
            Assert.Equal("terminated: Failed: The site is empty", check.Invoke(null, new object[] { " " }));
        }
    }
}
