using System;

namespace MiiXRay.Sources
{
    /// <summary>MII object names: forward slashes, no leading or trailing slash, no file extension.</summary>
    public static class ObjectPath
    {
        private static readonly string[] KnownExtensions = { ".trx", ".tqsq", ".tqxc", ".tqmd", ".tqxm" };

        public static string Normalize(string path)
        {
            if (path == null)
            {
                return string.Empty;
            }
            string result = path.Trim().Trim('"').Replace('\\', '/');
            while (result.Contains("//"))
            {
                result = result.Replace("//", "/");
            }
            result = result.Trim('/');
            foreach (string extension in KnownExtensions)
            {
                if (result.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
                {
                    return result.Substring(0, result.Length - extension.Length);
                }
            }
            return result;
        }

        public static string Folder(string path)
        {
            string normalized = Normalize(path);
            int slash = normalized.LastIndexOf('/');
            return slash > 0 ? normalized.Substring(0, slash) : string.Empty;
        }

        public static string Leaf(string path)
        {
            string normalized = Normalize(path);
            int slash = normalized.LastIndexOf('/');
            return slash >= 0 ? normalized.Substring(slash + 1) : normalized;
        }

        public static bool IsKnownExtension(string extension)
        {
            foreach (string known in KnownExtensions)
            {
                if (string.Equals(known, extension, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }
    }
}
