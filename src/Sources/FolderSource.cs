using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace MiiXRay.Sources
{
    /// <summary>A local folder with exported MII objects (a project export or a Workbench download).
    /// The folder layout rarely matches the logical paths exactly (export folders carry the project name,
    /// the objects reference the internal project name), so a path is resolved by its longest unique suffix.</summary>
    public sealed class FolderSource : IObjectSource
    {
        private readonly string _root;
        private Dictionary<string, List<string>> _bySuffix;
        private List<string> _allPaths;

        public FolderSource(string root)
        {
            _root = Path.GetFullPath(root);
        }

        public string Description
        {
            get { return "export folder " + _root; }
        }

        public void CheckConnection()
        {
            if (!Directory.Exists(_root))
            {
                throw new SourceException("The folder " + _root + " does not exist.",
                    "Check the export folder in the profile (it is the folder that contains the project folders).");
            }

            EnsureIndex();

            if (_allPaths.Count == 0)
            {
                throw new SourceException("The folder " + _root + " contains no MII objects (.trx, .tqsq, .tqmd, .tqxm, .tqxc).",
                    "Point the profile at the folder of an unpacked project export.");
            }
        }

        public LoadedObject Load(string objectPath)
        {
            EnsureIndex();
            string file = Resolve(ObjectPath.Normalize(objectPath));

            if (file == null)
            {
                return null;
            }

            LoadedObject result = new LoadedObject();
            result.CanonicalPath = RelativeWithoutExtension(file);
            result.Text = File.ReadAllText(file, Encoding.UTF8);
            return result;
        }

        public List<string> FindSimilar(string objectPath, int maximum)
        {
            EnsureIndex();
            return SimilarNames.Find(_allPaths, objectPath, maximum);
        }

        private string Resolve(string path)
        {
            if (path.Length == 0)
            {
                return null;
            }

            string[] parts = path.Split('/');

            for (int count = parts.Length; count >= 1; count--)
            {
                string key = string.Join("/", parts, parts.Length - count, count).ToLowerInvariant();
                List<string> hits;

                if (_bySuffix.TryGetValue(key, out hits))
                {
                    return hits.Count == 1 ? hits[0] : null;
                }
            }

            return null;
        }

        private void EnsureIndex()
        {
            if (_bySuffix != null)
            {
                return;
            }

            _bySuffix = new Dictionary<string, List<string>>();
            _allPaths = new List<string>();

            if (!Directory.Exists(_root))
            {
                return;
            }

            List<string> files = new List<string>(Directory.GetFiles(_root, "*", SearchOption.AllDirectories));
            files.Sort(StringComparer.Ordinal);

            foreach (string file in files)
            {
                if (!ObjectPath.IsKnownExtension(Path.GetExtension(file)))
                {
                    continue;
                }

                string relative = RelativeWithoutExtension(file);
                _allPaths.Add(relative);
                string[] parts = relative.Split('/');

                for (int count = 1; count <= parts.Length; count++)
                {
                    string key = string.Join("/", parts, parts.Length - count, count).ToLowerInvariant();
                    List<string> list;

                    if (!_bySuffix.TryGetValue(key, out list))
                    {
                        list = new List<string>();
                        _bySuffix.Add(key, list);
                    }

                    list.Add(file);
                }
            }
        }

        private string RelativeWithoutExtension(string file)
        {
            string relative = file.Substring(_root.Length).TrimStart('\\', '/');
            return ObjectPath.Normalize(relative);
        }
    }

    /// <summary>"Did you mean" over a list of object paths: same leaf name first, then leaf names that contain the
    /// searched name (or the other way round).</summary>
    public static class SimilarNames
    {
        public static List<string> Find(List<string> candidates, string objectPath, int maximum)
        {
            string leaf = ObjectPath.Leaf(objectPath).ToLowerInvariant();
            List<string> exact = new List<string>();
            List<string> partial = new List<string>();

            if (leaf.Length == 0)
            {
                return exact;
            }

            foreach (string candidate in candidates)
            {
                string candidateLeaf = ObjectPath.Leaf(candidate).ToLowerInvariant();

                if (candidateLeaf == leaf)
                {
                    exact.Add(candidate);
                }
                else if (candidateLeaf.Contains(leaf) || (candidateLeaf.Length >= 4 && leaf.Contains(candidateLeaf))
                    || EditDistance(candidateLeaf, leaf) <= Math.Max(2, leaf.Length / 6))
                {
                    partial.Add(candidate);
                }
            }

            exact.AddRange(partial);

            if (exact.Count > maximum)
            {
                exact.RemoveRange(maximum, exact.Count - maximum);
            }

            return exact;
        }

        /// <summary>Levenshtein distance: how many characters to insert, delete or change (for typos).</summary>
        public static int EditDistance(string first, string second)
        {
            int[] previous = new int[second.Length + 1];
            int[] current = new int[second.Length + 1];

            for (int j = 0; j <= second.Length; j++)
            {
                previous[j] = j;
            }

            for (int i = 1; i <= first.Length; i++)
            {
                current[0] = i;

                for (int j = 1; j <= second.Length; j++)
                {
                    int change = first[i - 1] == second[j - 1] ? 0 : 1;
                    current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + change);
                }

                int[] swap = previous;
                previous = current;
                current = swap;
            }

            return previous[second.Length];
        }
    }
}
