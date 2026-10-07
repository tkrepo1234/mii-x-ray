using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using MiiXRay.Cli;
using MiiXRay.Generate;
using MiiXRay.Profiles;
using MiiXRay.Sources;

namespace MiiXRay
{
    /// <summary>MII X-Ray: turns an SAP MII transaction, with every transaction and query it uses, into one C# file.
    /// Without arguments it runs the guided console; with arguments it runs once (for scripts).</summary>
    public static class Program
    {
        private const string Usage =
            "Usage:\n" +
            "  MiiXRay.exe                                        guided console (profiles, connection, transactions)\n" +
            "  MiiXRay.exe --profile <name> --trx <path> [--out <folder>]\n" +
            "  MiiXRay.exe --folder <export folder> --trx <path> [--out <folder>]\n" +
            "  MiiXRay.exe --folder <export folder> --all --out <folder>      every transaction of the folder\n" +
            "\n" +
            "  --profile   a profile saved in the guided console; a server profile without saved password\n" +
            "              reads it from the environment variable MIIXRAY_PASSWORD\n" +
            "  --folder    an unpacked MII project export instead of a profile\n" +
            "  --trx       the transaction, e.g. PROJECT/Folder/trxName (with or without .trx)\n" +
            "  --out       where the .xray.cs file goes (default: the profile's working directory or the current folder)\n" +
            "  --verbose   list every loaded object\n";

        public static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            try
            {
                if (args.Length == 0)
                {
                    ConsoleUi.Info("MII X-Ray " + CodeFile.ToolVersion + " - SAP MII transactions as plain C#");
                    new Session().Run();
                    return 0;
                }
                return RunOnce(args);
            }
            catch (OperationCanceledException)
            {
                return 1;
            }
            catch (Exception exception)
            {
                string log = WriteErrorLog(exception);
                ConsoleUi.Error("Unexpected error: " + exception.Message);
                ConsoleUi.Hint("This is a bug in MII X-Ray. Details: " + log);
                return 1;
            }
        }

        private static int RunOnce(string[] args)
        {
            Dictionary<string, string> options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 0; index < args.Length; index++)
            {
                string arg = args[index];
                if (arg == "--help" || arg == "-h" || arg == "/?")
                {
                    Console.Write(Usage.Replace("\n", Environment.NewLine));
                    return 0;
                }
                if (arg == "--all" || arg == "--verbose")
                {
                    options[arg] = "true";
                }
                else if (arg.StartsWith("--", StringComparison.Ordinal) && index + 1 < args.Length)
                {
                    options[arg] = args[++index];
                }
                else
                {
                    ConsoleUi.Error("Unknown argument: " + arg);
                    Console.Write(Usage.Replace("\n", Environment.NewLine));
                    return 2;
                }
            }

            try
            {
                return RunWithSource(options);
            }
            catch (SourceException exception)
            {
                ConsoleUi.Error(exception.Message);
                ConsoleUi.Hint(exception.Hint);
                return 1;
            }
        }

        private static int RunWithSource(Dictionary<string, string> options)
        {
            string output = Option(options, "--out");
            IObjectSource source;
            if (options.ContainsKey("--folder"))
            {
                source = new FolderSource(options["--folder"]);
            }
            else if (options.ContainsKey("--profile"))
            {
                Profile profile = FindProfile(options["--profile"]);
                if (profile == null)
                {
                    ConsoleUi.Error("There is no profile named " + options["--profile"] + ".");
                    ConsoleUi.Hint("Start MiiXRay.exe without arguments to create one.");
                    return 2;
                }
                source = SourceOf(profile);
                if (output == null)
                {
                    output = profile.OutputFolder;
                }
            }
            else
            {
                ConsoleUi.Error("Either --profile or --folder is needed.");
                Console.Write(Usage.Replace("\n", Environment.NewLine));
                return 2;
            }
            if (output == null)
            {
                output = Environment.CurrentDirectory;
            }

            source.CheckConnection();
            if (options.ContainsKey("--all"))
            {
                return RunAll(options, source, output);
            }
            string transaction = Option(options, "--trx");
            if (transaction == null)
            {
                ConsoleUi.Error("--trx is missing.");
                return 2;
            }
            XRayResult result;
            string file = new XRayRunner(source, options.ContainsKey("--verbose")).Run(transaction, output, out result);
            if (file == null)
            {
                return 1;
            }
            XRayRunner.Report(result, file);
            return 0;
        }

        /// <summary>Every transaction of an export folder, one file each (used to check X-Ray against a whole project).</summary>
        private static int RunAll(Dictionary<string, string> options, IObjectSource source, string output)
        {
            string folder = Option(options, "--folder");
            if (folder == null)
            {
                ConsoleUi.Error("--all needs --folder.");
                return 2;
            }
            int failed = 0;
            int written = 0;
            string[] files = Directory.GetFiles(folder, "*.trx", SearchOption.AllDirectories);
            Array.Sort(files, StringComparer.Ordinal);
            foreach (string file in files)
            {
                string relative = file.Substring(Path.GetFullPath(folder).TrimEnd('\\').Length + 1);
                try
                {
                    XRayResult result;
                    string target = new XRayRunner(source, false).Run(relative, Path.Combine(output, ObjectPath.Folder(relative).Replace('/', '\\')), out result);
                    if (target == null)
                    {
                        failed++;
                    }
                    else
                    {
                        written++;
                    }
                }
                catch (Exception exception)
                {
                    failed++;
                    ConsoleUi.Error(relative + ": " + exception.GetType().Name + ": " + exception.Message);
                    ConsoleUi.Dim(exception.StackTrace);
                }
            }
            ConsoleUi.Info(written + " written, " + failed + " failed.");
            return failed == 0 ? 0 : 1;
        }

        private static string Option(Dictionary<string, string> options, string name)
        {
            string value;
            return options.TryGetValue(name, out value) ? value : null;
        }

        private static Profile FindProfile(string name)
        {
            foreach (Profile profile in new ProfileStore().Load())
            {
                if (string.Equals(profile.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return profile;
                }
            }
            return null;
        }

        private static IObjectSource SourceOf(Profile profile)
        {
            if (profile.Kind == SourceKind.Folder)
            {
                return new FolderSource(profile.ExportFolder);
            }
            string password = ProfileStore.Unprotect(profile.ProtectedPassword) ?? Environment.GetEnvironmentVariable("MIIXRAY_PASSWORD");
            if (password == null)
            {
                throw new SourceException("The profile " + profile.Name + " has no saved password.",
                    "Save the password in the guided console or set the environment variable MIIXRAY_PASSWORD.");
            }
            return new CatalogSource(profile.Host, profile.Port, profile.UseHttps, profile.UserName, password, profile.AcceptAnyCertificate);
        }

        private static string WriteErrorLog(Exception exception)
        {
            try
            {
                Directory.CreateDirectory(ProfileStore.DataFolder);
                string path = Path.Combine(ProfileStore.DataFolder, "last-error.txt");
                File.WriteAllText(path, DateTime.Now.ToString("s") + Environment.NewLine + exception, Encoding.UTF8);
                return path;
            }
            catch (IOException)
            {
                return exception.ToString();
            }
            catch (UnauthorizedAccessException)
            {
                return exception.ToString();
            }
        }
    }
}
