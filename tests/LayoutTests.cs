using System.Collections.Generic;
using MiiXRay.Generate;

namespace MiiXRay.Tests
{
    public static class LayoutTests
    {
        private static string Layout(params string[] lines)
        {
            return string.Join("|", CodeLayout.AddBlankLines(new List<string>(lines)).ToArray());
        }

        public static void BlankLineAfterBlockUnlessBlockEnds()
        {
            Assert.Equal("{|if (a)|{|x();|}||y();|}", Layout("{", "if (a)", "{", "x();", "}", "y();", "}"));
            Assert.Equal("if (a)|{|}|else|{|}", Layout("if (a)", "{", "}", "else", "{", "}"));
        }

        public static void BlankLineBeforeControlWithItsComment()
        {
            Assert.Equal("x();||// Check|if (a)|{|}", Layout("x();", "// Check", "if (a)", "{", "}"));
            Assert.Equal("{|// Check|foreach (int i in l)|{|}|}", Layout("{", "// Check", "foreach (int i in l)", "{", "}", "}"));
        }
    }
}
