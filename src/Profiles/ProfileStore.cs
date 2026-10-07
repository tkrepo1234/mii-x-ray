using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Serialization;

namespace MiiXRay.Profiles
{
    /// <summary>Profiles in %APPDATA%\MiiXRay\profiles.xml. Passwords are stored only on request and then encrypted
    /// for the current Windows user (DPAPI), so the file is useless on another account or machine.</summary>
    public sealed class ProfileStore
    {
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("MiiXRay.Profile.v1");
        private readonly string _path;

        public ProfileStore()
            : this(Path.Combine(DataFolder, "profiles.xml"))
        {
        }

        public ProfileStore(string path)
        {
            _path = path;
        }

        public static string DataFolder
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "MiiXRay"); }
        }

        public string FilePath
        {
            get { return _path; }
        }

        public List<Profile> Load()
        {
            if (!File.Exists(_path))
            {
                return new List<Profile>();
            }

            XmlSerializer serializer = new XmlSerializer(typeof(List<Profile>), new XmlRootAttribute("Profiles"));

            using (FileStream stream = File.OpenRead(_path))
            {
                List<Profile> profiles = (List<Profile>)serializer.Deserialize(stream);
                return profiles ?? new List<Profile>();
            }
        }

        public void Save(List<Profile> profiles)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path));
            string temporary = _path + ".tmp";
            XmlSerializer serializer = new XmlSerializer(typeof(List<Profile>), new XmlRootAttribute("Profiles"));

            using (FileStream stream = File.Create(temporary))
            {
                serializer.Serialize(stream, profiles);
            }

            if (File.Exists(_path))
            {
                File.Replace(temporary, _path, null);
            }
            else
            {
                File.Move(temporary, _path);
            }
        }

        public static string Protect(string password)
        {
            if (string.IsNullOrEmpty(password))
            {
                return string.Empty;
            }

            byte[] encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(password), Entropy, DataProtectionScope.CurrentUser);
            return Convert.ToBase64String(encrypted);
        }

        /// <summary>The stored password, or null when there is none or it cannot be decrypted (other user or machine).</summary>
        public static string Unprotect(string protectedPassword)
        {
            if (string.IsNullOrEmpty(protectedPassword))
            {
                return null;
            }

            try
            {
                byte[] decrypted = ProtectedData.Unprotect(Convert.FromBase64String(protectedPassword), Entropy, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(decrypted);
            }
            catch (CryptographicException)
            {
                return null;
            }
            catch (FormatException)
            {
                return null;
            }
        }
    }
}
