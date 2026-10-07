using System;
using System.Collections.Generic;

namespace MiiXRay.Sources
{
    /// <summary>Where MII objects come from: an MII server (Catalog service) or a local export folder.</summary>
    public interface IObjectSource
    {
        /// <summary>One line for the console, e.g. "MII https://mii-dev:50001 as tim".</summary>
        string Description { get; }

        /// <summary>Throws SourceException with a hint when the source cannot be used.</summary>
        void CheckConnection();

        /// <summary>Loads an object by its logical path (with or without extension). Returns null when it does not exist.</summary>
        LoadedObject Load(string objectPath);

        /// <summary>Object paths that look like the given one (for "did you mean").</summary>
        List<string> FindSimilar(string objectPath, int maximum);
    }

    public sealed class LoadedObject
    {
        /// <summary>The object path as the source knows it (without extension).</summary>
        public string CanonicalPath;
        public string Text;
    }

    /// <summary>A problem with the source, with a hint what the user can do about it.</summary>
    public sealed class SourceException : Exception
    {
        private readonly string _hint;

        public SourceException(string message, string hint)
            : base(message)
        {
            _hint = hint;
        }

        public SourceException(string message, string hint, Exception inner)
            : base(message, inner)
        {
            _hint = hint;
        }

        public string Hint
        {
            get { return _hint; }
        }
    }
}
