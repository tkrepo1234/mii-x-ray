using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using MiiXRay.Generate;
using MiiXRay.Resolve;
using MiiXRay.Sources;

namespace MiiXRay.Cli
{
    /// <summary>One X-Ray: load the transaction with everything it uses, generate the C# file, write it.</summary>
    public sealed class XRayRunner
    {
        private readonly IObjectSource _source;
        private readonly bool _verbose;

        public XRayRunner(IObjectSource source, bool verbose)
        {
            _source = source;
            _verbose = verbose;
        }

        /// <summary>Returns the written file path, or null when the transaction does not exist (suggestions are printed).</summary>
        public string Run(string transactionPath, string outputFolder, out XRayResult result)
        {
            result = null;
            DependencyResolver resolver = new DependencyResolver(_source);
            int loaded = 0;
            resolver.Progress += delegate(string message)
            {
                loaded++;

                if (_verbose)
                {
                    ConsoleUi.Dim("  " + message);
                }
                else if (loaded % 10 == 0)
                {
                    Console.Write(".");
                }
            };

            ObjectGraph graph = resolver.Resolve(transactionPath);

            if (!_verbose && loaded >= 10)
            {
                Console.WriteLine();
            }

            if (graph == null)
            {
                ConsoleUi.Error("The transaction " + ObjectPath.Normalize(transactionPath) + " was not found (or is no transaction).");
                List<string> similar = _source.FindSimilar(transactionPath, 8);

                if (similar.Count > 0)
                {
                    ConsoleUi.Info("  Similar objects:");

                    foreach (string candidate in similar)
                    {
                        ConsoleUi.Info("    " + candidate);
                    }
                }
                else
                {
                    ConsoleUi.Hint("Write the path as in the Workbench, e.g. PROJECT/Folder/trxName (with or without .trx).");
                }

                return null;
            }

            result = CodeFile.Generate(graph, _source.Description);
            Directory.CreateDirectory(outputFolder);
            string file = Path.Combine(outputFolder, result.RootClassName + ".xray.cs");
            File.WriteAllText(file, result.Code, new UTF8Encoding(true));
            return file;
        }

        public static void Report(XRayResult result, string file)
        {
            ConsoleUi.Success("Written: " + file);
            ConsoleUi.Info("  " + result.TransactionCount + " transaction(s), " + result.QueryCount + " query template(s)"
                + (result.Missing.Count > 0 ? ", " + result.Missing.Count + " not found" : string.Empty)
                + (result.Notes.Count > 0 ? ", " + result.Notes.Count + " note(s) in the file header" : string.Empty) + ".");

            foreach (string missing in result.Missing)
            {
                ConsoleUi.Warning("  not found: " + missing);
            }
        }
    }
}
