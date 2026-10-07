using System;
using System.Collections.Generic;
using System.Xml.Serialization;

namespace MiiXRay.Profiles
{
    public enum SourceKind
    {
        /// <summary>An SAP MII server, read through the Catalog service.</summary>
        Server,
        /// <summary>A local folder with exported MII objects.</summary>
        Folder
    }

    /// <summary>Everything X-Ray needs to read from one system and where to write the results.</summary>
    public sealed class Profile
    {
        public Profile()
        {
            Name = string.Empty;
            Kind = SourceKind.Server;
            Host = string.Empty;
            Port = 50000;
            UserName = string.Empty;
            ProtectedPassword = string.Empty;
            ExportFolder = string.Empty;
            OutputFolder = string.Empty;
            RecentTransactions = new List<string>();
        }

        public string Name { get; set; }
        public SourceKind Kind { get; set; }
        public string Host { get; set; }
        public int Port { get; set; }
        public bool UseHttps { get; set; }
        public string UserName { get; set; }

        /// <summary>The password encrypted for the current Windows user (DPAPI), or empty when it is asked every time.</summary>
        public string ProtectedPassword { get; set; }

        public bool AcceptAnyCertificate { get; set; }
        public string ExportFolder { get; set; }
        public string OutputFolder { get; set; }

        [XmlArrayItem("Path")]
        public List<string> RecentTransactions { get; set; }

        public string Summary()
        {
            if (Kind == SourceKind.Folder)
            {
                return Name + "  (export folder " + ExportFolder + ")";
            }

            return Name + "  (" + (UseHttps ? "https" : "http") + "://" + Host + ":" + Port + ", user " + UserName + ")";
        }

        /// <summary>Puts a transaction path at the top of the recent list (at most 9 entries).</summary>
        public void Remember(string transactionPath)
        {
            RecentTransactions.RemoveAll(delegate(string existing) { return string.Equals(existing, transactionPath, StringComparison.OrdinalIgnoreCase); });
            RecentTransactions.Insert(0, transactionPath);

            if (RecentTransactions.Count > 9)
            {
                RecentTransactions.RemoveRange(9, RecentTransactions.Count - 9);
            }
        }
    }
}
