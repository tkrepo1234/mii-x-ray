using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace MiiXRay.SimConvert;

/// <summary>
/// Converts default-mode X-Ray files (.xray.cs of MII X-Ray 2.5 or later) into the simulation mode.
///   SimConvert in.xray.cs out.sim.cs
///   SimConvert --batch list.txt          (one "input|output" pair per line)
/// </summary>
public static class Program
{
    public static int Main(string[] args)
    {
        List<(string Input, string Output)> pairs = [];

        if (args.Length == 2 && args[0] == "--batch")
        {
            foreach (string line in File.ReadAllLines(args[1]))
            {
                int bar = line.IndexOf('|');

                if (bar > 0)
                {
                    pairs.Add((line.Substring(0, bar), line.Substring(bar + 1)));
                }
            }
        }
        else if (args.Length == 2)
        {
            pairs.Add((args[0], args[1]));
        }
        else
        {
            Console.Error.WriteLine("usage: SimConvert <in.xray.cs> <out.sim.cs> | SimConvert --batch <list file>");
            return 2;
        }

        Converter converter = new Converter(References.Load());
        int failed = 0;

        foreach ((string input, string output) in pairs)
        {
            try
            {
                string text = File.ReadAllText(input, Encoding.UTF8);
                string result = converter.Convert(text);
                File.WriteAllText(output, result, new UTF8Encoding(true));
            }
            catch (Exception exception)
            {
                failed++;
                Console.WriteLine("FAILED " + input + ": " + exception.Message);
            }
        }

        Console.WriteLine("converted " + (pairs.Count - failed) + " of " + pairs.Count);
        return failed == 0 ? 0 : 1;
    }
}
