using System;
using System.Collections.Generic;
using System.Reflection;

namespace MiiXRay.Tests
{
    /// <summary>A minimal test runner without packages: every public static void method of a class ending in "Tests"
    /// is a test; a test fails by throwing.</summary>
    public static class TestProgram
    {
        public static int Main(string[] args)
        {
            int passed = 0;
            List<string> failures = new List<string>();

            foreach (Type type in typeof(TestProgram).Assembly.GetTypes())
            {
                if (!type.Name.EndsWith("Tests", StringComparison.Ordinal) || type.Namespace != "MiiXRay.Tests")
                {
                    continue;
                }

                foreach (MethodInfo method in type.GetMethods(BindingFlags.Public | BindingFlags.Static))
                {
                    if (method.ReturnType != typeof(void) || method.GetParameters().Length > 0)
                    {
                        continue;
                    }

                    try
                    {
                        method.Invoke(null, null);
                        passed++;
                    }
                    catch (TargetInvocationException exception)
                    {
                        failures.Add(type.Name + "." + method.Name + ": " + exception.InnerException.Message);
                    }
                }
            }

            foreach (string failure in failures)
            {
                Console.WriteLine("FAIL " + failure);
            }

            Console.WriteLine(passed + " passed, " + failures.Count + " failed");
            return failures.Count == 0 ? 0 : 1;
        }
    }

    public static class Assert
    {
        public static void Equal(object expected, object actual)
        {
            if (!object.Equals(expected, actual))
            {
                throw new Exception("expected <" + expected + "> but was <" + actual + ">");
            }
        }

        public static void True(bool condition, string message)
        {
            if (!condition)
            {
                throw new Exception(message);
            }
        }

        public static void Contains(string expected, string text)
        {
            if (text == null || text.IndexOf(expected, StringComparison.Ordinal) < 0)
            {
                throw new Exception("expected to contain <" + expected + "> in:" + Environment.NewLine + text);
            }
        }

        public static void NotContains(string unexpected, string text)
        {
            if (text != null && text.IndexOf(unexpected, StringComparison.Ordinal) >= 0)
            {
                throw new Exception("expected not to contain <" + unexpected + "> in:" + Environment.NewLine + text);
            }
        }
    }
}
