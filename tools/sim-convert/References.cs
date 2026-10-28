using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;

namespace MiiXRay.SimConvert;

/// <summary>The .NET 8 reference assemblies the X-Ray files are written against (for the types of var declarations).</summary>
public static class References
{
    public static List<MetadataReference> Load()
    {
        string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet", "packs", "Microsoft.NETCore.App.Ref");
        string version = Directory.Exists(root)
            ? Directory.GetDirectories(root).Select(Path.GetFileName).Where((name) => name.StartsWith("8.")).OrderBy((name) => Version.TryParse(name, out Version parsed) ? parsed : new Version()).LastOrDefault()
            : null;

        if (version == null)
        {
            throw new InvalidOperationException("The .NET 8 reference assemblies are missing (" + root + "\\8.*).");
        }

        string folder = Path.Combine(root, version, "ref", "net8.0");
        return Directory.GetFiles(folder, "*.dll").Select((file) => (MetadataReference)MetadataReference.CreateFromFile(file)).ToList();
    }
}
