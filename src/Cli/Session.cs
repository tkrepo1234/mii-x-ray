using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using MiiXRay.Generate;
using MiiXRay.Profiles;
using MiiXRay.Sources;

namespace MiiXRay.Cli
{
    /// <summary>The guided console: choose or create a profile, connect, then X-Ray one transaction after the other.</summary>
    public sealed class Session
    {
        private readonly ProfileStore _store = new ProfileStore();
        private List<Profile> _profiles;

        public void Run()
        {
            _profiles = LoadProfiles();

            while (true)
            {
                Profile profile = ChooseProfile();

                if (profile == null)
                {
                    return;
                }

                IObjectSource source = Connect(profile);

                if (source != null)
                {
                    RunTransactions(profile, source);
                }
            }
        }

        private List<Profile> LoadProfiles()
        {
            try
            {
                return _store.Load();
            }
            catch (InvalidOperationException exception)
            {
                ConsoleUi.Warning("The profile file " + _store.FilePath + " could not be read: " + exception.Message);
                ConsoleUi.Hint("Starting without profiles. The file is replaced when a profile is saved; rename it first to keep it.");
                return new List<Profile>();
            }
        }

        private void SaveProfiles()
        {
            try
            {
                _store.Save(_profiles);
            }
            catch (Exception exception)
            {
                if (exception is IOException || exception is UnauthorizedAccessException)
                {
                    ConsoleUi.Warning("The profiles could not be saved: " + exception.Message);
                    ConsoleUi.Hint("Check that " + ProfileStore.DataFolder + " is writable.");
                    return;
                }

                throw;
            }
        }

        // ------------------------------------------------------------------ profiles

        private Profile ChooseProfile()
        {
            while (true)
            {
                ConsoleUi.Title("Profiles");

                if (_profiles.Count == 0)
                {
                    ConsoleUi.Info("No profile yet. A profile says where the transactions come from (an MII server or an export folder)");
                    ConsoleUi.Info("and where the C# files go. It is stored in " + _store.FilePath + ".");
                    Profile created = EditProfile(new Profile());

                    if (created != null)
                    {
                        return created;
                    }

                    continue;
                }

                List<string> options = new List<string>();

                foreach (Profile profile in _profiles)
                {
                    options.Add(profile.Summary());
                }

                int create = options.Count;
                options.Add("New profile");
                options.Add("Edit a profile");
                options.Add("Delete a profile");
                options.Add("Quit");
                int choice = ConsoleUi.Choose("Choose", options, 0);

                if (choice < create)
                {
                    return _profiles[choice];
                }

                if (choice == create)
                {
                    Profile created = EditProfile(new Profile());

                    if (created != null)
                    {
                        return created;
                    }
                }
                else if (choice == create + 1)
                {
                    Profile chosen = PickExisting("Which profile to edit");

                    if (chosen != null)
                    {
                        EditProfile(chosen);
                    }
                }
                else if (choice == create + 2)
                {
                    Profile chosen = PickExisting("Which profile to delete");

                    if (chosen != null && ConsoleUi.AskYesNo("Delete profile " + chosen.Name + "?", false))
                    {
                        _profiles.Remove(chosen);
                        SaveProfiles();
                    }
                }
                else
                {
                    return null;
                }
            }
        }

        private Profile PickExisting(string question)
        {
            List<string> names = new List<string>();

            foreach (Profile profile in _profiles)
            {
                names.Add(profile.Summary());
            }

            names.Add("Back");
            int choice = ConsoleUi.Choose(question, names, names.Count - 1);
            return choice < _profiles.Count ? _profiles[choice] : null;
        }

        /// <summary>Asks every setting of a profile (current values as defaults) and saves it.</summary>
        private Profile EditProfile(Profile profile)
        {
            bool isNew = !_profiles.Contains(profile);
            ConsoleUi.Title(isNew ? "New profile" : "Edit profile " + profile.Name);
            string name = ConsoleUi.AskRequired("Profile name (e.g. DEV, QA, Export)", profile.Name);
            Profile sameName = FindProfile(name);

            if (sameName != null && sameName != profile)
            {
                ConsoleUi.Warning("A profile named " + name + " exists already; it will be edited instead.");
                profile = sameName;
                isNew = false;
            }

            profile.Name = name;

            List<string> kinds = new List<string>();
            kinds.Add("SAP MII server (reads through the Catalog service)");
            kinds.Add("Local export folder (an unpacked project export)");
            profile.Kind = ConsoleUi.Choose("Where do the transactions come from", kinds, profile.Kind == SourceKind.Folder ? 1 : 0) == 1 ? SourceKind.Folder : SourceKind.Server;

            if (profile.Kind == SourceKind.Server)
            {
                profile.Host = CleanHost(ConsoleUi.AskRequired("Host name of the MII server (e.g. mii-dev.company.local)", profile.Host));
                profile.UseHttps = ConsoleUi.AskYesNo("Use https", isNew ? true : profile.UseHttps);
                int defaultPort = isNew ? (profile.UseHttps ? 50001 : 50000) : profile.Port;
                profile.Port = ConsoleUi.AskNumber("Port", defaultPort, 1, 65535);

                if (profile.UseHttps)
                {
                    profile.AcceptAnyCertificate = ConsoleUi.AskYesNo("Accept a certificate this PC does not trust (only for test systems)", profile.AcceptAnyCertificate);
                }

                profile.UserName = ConsoleUi.AskRequired("MII user", profile.UserName.Length > 0 ? profile.UserName : Environment.UserName);
                bool hasPassword = profile.ProtectedPassword.Length > 0;

                if (ConsoleUi.AskYesNo(hasPassword ? "Change the saved password" : "Save the password (encrypted for your Windows user)", false))
                {
                    profile.ProtectedPassword = ProfileStore.Protect(ConsoleUi.AskPassword("Password"));
                }
                else if (hasPassword && ConsoleUi.AskYesNo("Forget the saved password (ask every time)", false))
                {
                    profile.ProtectedPassword = string.Empty;
                }
            }
            else
            {
                while (true)
                {
                    string folder = ConsoleUi.AskRequired("Export folder", profile.ExportFolder).Trim('"');

                    if (Directory.Exists(folder))
                    {
                        profile.ExportFolder = Path.GetFullPath(folder);
                        break;
                    }

                    ConsoleUi.Warning("  The folder " + folder + " does not exist.");
                }
            }

            string defaultOutput = profile.OutputFolder.Length > 0
                ? profile.OutputFolder
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "MiiXRay");

            while (true)
            {
                string folder = ConsoleUi.AskRequired("Working directory for the generated C# files", defaultOutput).Trim('"');
                string problem = CheckWritableFolder(folder);

                if (problem == null)
                {
                    profile.OutputFolder = Path.GetFullPath(folder);
                    break;
                }

                ConsoleUi.Warning("  " + problem);
            }

            if (isNew)
            {
                _profiles.Add(profile);
            }

            SaveProfiles();
            ConsoleUi.Success("Profile " + profile.Name + " saved.");
            return profile;
        }

        /// <summary>Null when the folder exists or can be created and written to, else what is wrong.</summary>
        private static string CheckWritableFolder(string folder)
        {
            try
            {
                string full = Path.GetFullPath(folder);
                Directory.CreateDirectory(full);
                string probe = Path.Combine(full, ".miixray-write-test");
                File.WriteAllText(probe, string.Empty);
                File.Delete(probe);
                return null;
            }
            catch (Exception exception)
            {
                if (exception is ArgumentException || exception is NotSupportedException || exception is IOException
                    || exception is UnauthorizedAccessException || exception is System.Security.SecurityException)
                {
                    return "The folder cannot be used: " + exception.Message;
                }

                throw;
            }
        }

        /// <summary>"https://host:50001/XMII/..." pasted as host -> "host".</summary>
        private static string CleanHost(string host)
        {
            string value = host.Trim();
            int scheme = value.IndexOf("://", StringComparison.Ordinal);

            if (scheme >= 0)
            {
                value = value.Substring(scheme + 3);
            }

            int slash = value.IndexOf('/');

            if (slash >= 0)
            {
                value = value.Substring(0, slash);
            }

            int colon = value.IndexOf(':');
            return colon >= 0 ? value.Substring(0, colon) : value;
        }

        private Profile FindProfile(string name)
        {
            foreach (Profile profile in _profiles)
            {
                if (string.Equals(profile.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return profile;
                }
            }

            return null;
        }

        // ------------------------------------------------------------------ connection

        /// <summary>Creates the source and checks it; on a problem the user can retry, edit the profile or go back.</summary>
        private IObjectSource Connect(Profile profile)
        {
            string password = null;
            bool useStoredPassword = true;
            bool typedPassword = false;

            while (true)
            {
                IObjectSource source;

                if (profile.Kind == SourceKind.Folder)
                {
                    source = new FolderSource(profile.ExportFolder);
                }
                else
                {
                    if (password == null && useStoredPassword)
                    {
                        password = ProfileStore.Unprotect(profile.ProtectedPassword);

                        if (password == null && profile.ProtectedPassword.Length > 0)
                        {
                            ConsoleUi.Warning("The saved password cannot be read on this account; please enter it.");
                        }
                    }

                    if (password == null)
                    {
                        password = ConsoleUi.AskPassword("Password for " + profile.UserName + " on " + profile.Host);
                        typedPassword = true;
                    }

                    source = new CatalogSource(profile.Host, profile.Port, profile.UseHttps, profile.UserName, password, profile.AcceptAnyCertificate);
                }

                ConsoleUi.Info("Connecting to " + source.Description + " ...");

                try
                {
                    source.CheckConnection();
                    ConsoleUi.Success("Connected.");

                    if (typedPassword && profile.ProtectedPassword.Length > 0)
                    {
                        // the profile keeps a password: keep the one that worked
                        profile.ProtectedPassword = ProfileStore.Protect(password);
                        SaveProfiles();
                    }

                    return source;
                }
                catch (SourceException exception)
                {
                    ConsoleUi.Error(exception.Message);
                    ConsoleUi.Hint(exception.Hint);
                }

                List<string> options = new List<string>();
                options.Add("Try again");
                options.Add("Edit the profile");
                options.Add("Enter the password again");
                options.Add("Back to the profiles");
                int choice = ConsoleUi.Choose("What now", options, 0);

                if (choice == 1)
                {
                    EditProfile(profile);
                    password = null;
                }
                else if (choice == 2)
                {
                    password = null;
                    useStoredPassword = false;
                }
                else if (choice == 3)
                {
                    return null;
                }
            }
        }

        // ------------------------------------------------------------------ X-Ray

        private void RunTransactions(Profile profile, IObjectSource source)
        {
            XRayRunner runner = new XRayRunner(source, false);

            while (true)
            {
                ConsoleUi.Title("X-Ray (" + profile.Name + ")");
                string path = AskTransaction(profile);

                if (path == null)
                {
                    return;
                }

                if (path.Length == 0)
                {
                    continue;
                }

                ConsoleUi.Info("Loading " + ObjectPath.Normalize(path) + " and everything it uses ...");

                try
                {
                    XRayResult result;
                    string file = runner.Run(path, profile.OutputFolder, out result);

                    if (file == null)
                    {
                        continue;
                    }

                    profile.Remember(ObjectPath.Normalize(path));
                    SaveProfiles();
                    XRayRunner.Report(result, file);

                    if (ConsoleUi.AskYesNo("Open the working directory", false))
                    {
                        Process.Start("explorer.exe", "/select,\"" + file + "\"");
                    }
                }
                catch (SourceException exception)
                {
                    ConsoleUi.Error(exception.Message);
                    ConsoleUi.Hint(exception.Hint);
                }
                catch (IOException exception)
                {
                    ConsoleUi.Error("The file could not be written: " + exception.Message);
                    ConsoleUi.Hint("Close the file if it is open in an editor, or edit the profile and choose another working directory.");
                }
                catch (ArgumentException exception)
                {
                    ConsoleUi.Error("The working directory is not a valid path: " + exception.Message);
                    ConsoleUi.Hint("Edit the profile and choose another working directory.");
                }
                catch (UnauthorizedAccessException exception)
                {
                    ConsoleUi.Error("No permission to write: " + exception.Message);
                    ConsoleUi.Hint("Edit the profile and choose a working directory you may write to.");
                }
            }
        }

        /// <summary>The path to X-Ray, "" to ask again, null to go back to the profiles.</summary>
        private static string AskTransaction(Profile profile)
        {
            if (profile.RecentTransactions.Count > 0)
            {
                ConsoleUi.Info("Recent:");

                for (int index = 0; index < profile.RecentTransactions.Count; index++)
                {
                    ConsoleUi.Info("  " + (index + 1) + ") " + profile.RecentTransactions[index]);
                }
            }

            ConsoleUi.Dim("Enter a transaction path (PROJECT/Folder/trxName), a number from the list, 'p' for the profiles or 'q' to quit.");
            string answer = ConsoleUi.Ask("Transaction", string.Empty);

            if (answer.Length == 0)
            {
                return string.Empty;
            }

            if (answer == "p" || answer == "P")
            {
                return null;
            }

            if (answer == "q" || answer == "Q")
            {
                Environment.Exit(0);
            }

            int number;

            if (int.TryParse(answer, out number))
            {
                if (number >= 1 && number <= profile.RecentTransactions.Count)
                {
                    return profile.RecentTransactions[number - 1];
                }

                ConsoleUi.Warning("  There is no entry " + number + ".");
                return string.Empty;
            }

            return answer;
        }
    }
}
