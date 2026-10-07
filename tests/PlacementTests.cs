using System.Collections.Generic;
using MiiXRay.Generate;

namespace MiiXRay.Tests
{
    public static class PlacementTests
    {
        private static HoistedVariable Variable(string name, bool isCatch)
        {
            HoistedVariable variable = new HoistedVariable();
            variable.Type = isCatch ? "Exception" : "T";
            variable.Name = name;
            variable.Initializer = "null";
            variable.IsCatch = isCatch;
            return variable;
        }

        private static List<string> Lines(params string[] lines)
        {
            return new List<string>(lines);
        }

        public static void DeclaresAtAssignmentWhenReadInsideOnly()
        {
            List<string> flow = Lines("if (a)", "{", "    x = Load();", "    Use(x);", "}");
            List<HoistedVariable> left = DeclarationPlacer.Place(flow, new List<HoistedVariable> { Variable("x", false) });
            Assert.Equal(0, left.Count);
            Assert.Equal("    var x = Load();", flow[2]);
        }

        public static void KeepsAtTopWhenReadAfterTheBlock()
        {
            List<string> flow = Lines("if (a)", "{", "    x = Load();", "}", "Use(x);");
            Assert.Equal(1, DeclarationPlacer.Place(flow, new List<HoistedVariable> { Variable("x", false) }).Count);
            Assert.Equal("    x = Load();", flow[2]);
        }

        public static void KeepsAtTopWhenReadBeforeOrAssignedTwice()
        {
            List<string> before = Lines("foreach (int i in l)", "{", "    Use(x);", "    x = Load();", "}");
            Assert.Equal(1, DeclarationPlacer.Place(before, new List<HoistedVariable> { Variable("x", false) }).Count);
            List<string> twice = Lines("x = Load();", "x = Load();");
            Assert.Equal(1, DeclarationPlacer.Place(twice, new List<HoistedVariable> { Variable("x", false) }).Count);
        }

        public static void CatchResultBecomesTheCatchVariable()
        {
            List<string> flow = Lines("try", "{", "    Run();", "}", "catch (Exception failedError)", "{", "    failed = failedError;", "    Log(failed);", "}");
            Assert.Equal(0, DeclarationPlacer.Place(flow, new List<HoistedVariable> { Variable("failed", true) }).Count);
            Assert.Equal("try|{|    Run();|}|catch (Exception failed)|{|    Log(failed);|}", string.Join("|", flow.ToArray()));
        }
    }
}
