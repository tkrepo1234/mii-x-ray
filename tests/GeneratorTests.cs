using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using MiiXRay.Generate;
using MiiXRay.Resolve;
using MiiXRay.Sources;

namespace MiiXRay.Tests
{
    /// <summary>End to end: an export folder with a small transaction and a query, X-Rayed, compiled as C# 12 and run on .NET 8.</summary>
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
            "using System;\n" +
            "using System.Collections.Generic;\n" +
            "namespace XRay.TrxCheckSite;\n" +
            "public sealed class FakeQueries : IQueryService\n" +
            "{\n" +
            "    public List<T> Execute<T>(Query query) where T : MiiRow, new() =>\n" +
            "        Mii.ToRows<T>(Mii.ParseXml($\"<Rowsets><Rowset><Row><Sfc>S1-{query.Parameters[0].Value}</Sfc></Row><Row><Sfc>S2</Sfc></Row></Rowset></Rowsets>\"));\n" +
            "    public void ExecuteCommand(Query query) { }\n" +
            "}\n" +
            "public static class Program\n" +
            "{\n" +
            "    public static void Main()\n" +
            "    {\n" +
            "        Console.WriteLine(Check(\"M\"));\n" +
            "        Console.WriteLine(Check(\" \"));\n" +
            "    }\n" +
            "    private static string Check(string site)\n" +
            "    {\n" +
            "        try\n" +
            "        {\n" +
            "            var result = new TrxCheckSiteLogic(new FakeQueries(), null).TrxCheckSite(site: site);\n" +
            "            return result.Message + \" | \" + result.Sfcs.Count;\n" +
            "        }\n" +
            "        catch (TransactionTerminatedException exception)\n" +
            "        {\n" +
            "            return \"terminated: \" + exception.Message;\n" +
            "        }\n" +
            "    }\n" +
            "}\n";

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
            Assert.Contains("public TrxCheckSiteResult TrxCheckSite(string site = default)", code);
            Assert.Contains("if (Regex.IsMatch(site, @\"^\\s*$\"))", code);
            Assert.Contains("throw new MiiException(\"The site is empty\", \"ThrowEmptySite\");", code);
            Assert.Contains("// [Param.1] = Site", code);
            Assert.Contains("var sqlSelectSfcs = new Query(\"\"\"select SFC as \"Sfc\" from SFC where SITE = '[Param.1]'\"\"\");", code);
            Assert.Contains("sqlSelectSfcs.AddParameter(\"Site\", site);", code);
            Assert.Contains("var selectSfcs = queries.Execute<SqlSelectSfcsRow>(sqlSelectSfcs);", code);
            Assert.Contains("message = $\"Site {site}: {selectSfcs.Count} SFC, first {selectSfcs.FirstOrEmpty().Sfc}\";", code);
            Assert.Contains("catch (Exception catchAll)", code);
            Assert.Contains("public sealed record TrxCheckSiteResult(string Message, List<SfcsRow> Sfcs);", code);
            Assert.Contains("public string Sfc { get; set; } = \"\";", code);
            Assert.Contains("return new TrxCheckSiteResult(message, sfcs);", code);
        }

        public static void CompilesAndRunsOnDotNet8()
        {
            ModernCompiler compiler = ModernCompiler.Find();

            if (compiler == null)
            {
                Console.WriteLine("  (CompilesAndRunsOnDotNet8 skipped: no .NET SDK with the .NET 8 reference pack found)");
                return;
            }

            string folder = Path.Combine(Path.GetTempPath(), "mii-x-ray-run-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);

            try
            {
                File.WriteAllText(Path.Combine(folder, "Logic.cs"), Generate(), Encoding.UTF8);
                File.WriteAllText(Path.Combine(folder, "Runner.cs"), Runner, Encoding.UTF8);
                string output = compiler.CompileAndRun(folder, new string[] { "Logic.cs", "Runner.cs" });
                Assert.Equal("Site M: 2 SFC, first S1-M | 2\nterminated: Failed: The site is empty\n", output.Replace("\r\n", "\n"));
            }
            finally
            {
                Directory.Delete(folder, true);
            }
        }
    }

    /// <summary>Roslyn of an installed .NET SDK and the .NET 8 reference assemblies (C:\Program Files\dotnet).</summary>
    public sealed class ModernCompiler
    {
        private string _dotnet;
        private string _csc;
        private string _references;
        private string _runtimeVersion;

        public static ModernCompiler Find()
        {
            string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet");
            string dotnet = Path.Combine(root, "dotnet.exe");
            string csc = Last(Path.Combine(root, "sdk"), "Roslyn\\bincore\\csc.dll", string.Empty);
            string references = Last(Path.Combine(root, "packs\\Microsoft.NETCore.App.Ref"), "ref\\net8.0", "8.");
            string runtime = Last(Path.Combine(root, "shared\\Microsoft.NETCore.App"), string.Empty, "8.");

            if (!File.Exists(dotnet) || csc == null || references == null || runtime == null)
            {
                return null;
            }

            ModernCompiler compiler = new ModernCompiler();
            compiler._dotnet = dotnet;
            compiler._csc = csc;
            compiler._references = references;
            compiler._runtimeVersion = Path.GetFileName(runtime.TrimEnd('\\'));
            return compiler;
        }

        private static string Last(string folder, string below, string prefix)
        {
            if (!Directory.Exists(folder))
            {
                return null;
            }

            string[] versions = Directory.GetDirectories(folder, prefix + "*");
            Array.Sort(versions, StringComparer.Ordinal);

            for (int index = versions.Length - 1; index >= 0; index--)
            {
                string candidate = below.Length > 0 ? Path.Combine(versions[index], below) : versions[index];

                if (File.Exists(candidate) || Directory.Exists(candidate))
                {
                    return candidate;
                }
            }

            return null;
        }

        /// <summary>Compiles the files to an executable for .NET 8 and runs it; returns its output.</summary>
        public string CompileAndRun(string folder, string[] files)
        {
            StringBuilder arguments = new StringBuilder();
            arguments.Append('"').Append(_csc).Append("\" -nologo -langversion:12 -nostdlib -target:exe -out:run.dll");

            foreach (string reference in Directory.GetFiles(_references, "*.dll"))
            {
                arguments.Append(" \"-r:").Append(reference).Append('"');
            }

            foreach (string file in files)
            {
                arguments.Append(' ').Append(file);
            }

            string compile = Run(folder, arguments.ToString());

            if (!File.Exists(Path.Combine(folder, "run.dll")))
            {
                throw new Exception("C# 12 compile failed:" + Environment.NewLine + compile);
            }

            File.WriteAllText(Path.Combine(folder, "run.runtimeconfig.json"),
                "{ \"runtimeOptions\": { \"tfm\": \"net8.0\", \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \"" + _runtimeVersion + "\" } } }");
            return Run(folder, "run.dll");
        }

        private string Run(string folder, string arguments)
        {
            ProcessStartInfo start = new ProcessStartInfo(_dotnet, arguments);
            start.WorkingDirectory = folder;
            start.UseShellExecute = false;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.CreateNoWindow = true;

            using (Process process = Process.Start(start))
            {
                string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                process.WaitForExit();
                return output;
            }
        }
    }
}
