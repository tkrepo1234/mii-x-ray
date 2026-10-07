using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace MiiXRay.Cli
{
    /// <summary>Prompts and messages. Every question shows its default in brackets; Enter takes the default.</summary>
    public static class ConsoleUi
    {
        public static void Title(string text)
        {
            Console.WriteLine();
            Write(ConsoleColor.Cyan, text);
            Write(ConsoleColor.DarkCyan, new string('-', Math.Min(text.Length, 78)));
        }

        public static void Info(string text)
        {
            Console.WriteLine(text);
        }

        public static void Success(string text)
        {
            Write(ConsoleColor.Green, text);
        }

        public static void Warning(string text)
        {
            Write(ConsoleColor.Yellow, text);
        }

        public static void Error(string text)
        {
            Write(ConsoleColor.Red, text);
        }

        /// <summary>What the user can do about a problem.</summary>
        public static void Hint(string text)
        {
            Write(ConsoleColor.Gray, "  -> " + text);
        }

        public static void Dim(string text)
        {
            Write(ConsoleColor.DarkGray, text);
        }

        private static void Write(ConsoleColor color, string text)
        {
            ConsoleColor previous = Console.ForegroundColor;
            Console.ForegroundColor = color;
            Console.WriteLine(text);
            Console.ForegroundColor = previous;
        }

        public static string Ask(string question, string defaultValue)
        {
            Console.Write(question + (string.IsNullOrEmpty(defaultValue) ? ": " : " [" + defaultValue + "]: "));
            string answer = Console.ReadLine();

            if (answer == null)
            {
                throw new OperationCanceledException("The input ended.");
            }

            answer = answer.Trim();
            return answer.Length == 0 ? (defaultValue ?? string.Empty) : answer;
        }

        public static string AskRequired(string question, string defaultValue)
        {
            while (true)
            {
                string answer = Ask(question, defaultValue);

                if (answer.Length > 0)
                {
                    return answer;
                }

                Warning("  Please enter a value.");
            }
        }

        public static int AskNumber(string question, int defaultValue, int minimum, int maximum)
        {
            while (true)
            {
                string answer = Ask(question, defaultValue.ToString(CultureInfo.InvariantCulture));
                int value;

                if (int.TryParse(answer, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) && value >= minimum && value <= maximum)
                {
                    return value;
                }

                Warning("  Please enter a number from " + minimum + " to " + maximum + ".");
            }
        }

        public static bool AskYesNo(string question, bool defaultValue)
        {
            while (true)
            {
                string answer = Ask(question + " (y/n)", defaultValue ? "y" : "n").ToLowerInvariant();

                if (answer == "y" || answer == "yes" || answer == "j" || answer == "ja")
                {
                    return true;
                }

                if (answer == "n" || answer == "no" || answer == "nein")
                {
                    return false;
                }

                Warning("  Please answer y or n.");
            }
        }

        /// <summary>Reads a password without echo (stars instead).</summary>
        public static string AskPassword(string question)
        {
            Console.Write(question + ": ");

            if (Console.IsInputRedirected)
            {
                string line = Console.ReadLine();
                return line ?? string.Empty;
            }

            StringBuilder password = new StringBuilder();

            while (true)
            {
                ConsoleKeyInfo key = Console.ReadKey(true);

                if (key.Key == ConsoleKey.Enter)
                {
                    break;
                }

                if (key.Key == ConsoleKey.Backspace)
                {
                    if (password.Length > 0)
                    {
                        password.Length--;
                        Console.Write("\b \b");
                    }
                }
                else if (!char.IsControl(key.KeyChar))
                {
                    password.Append(key.KeyChar);
                    Console.Write('*');
                }
            }

            Console.WriteLine();
            return password.ToString();
        }

        /// <summary>A numbered menu; returns the index of the chosen option.</summary>
        public static int Choose(string question, List<string> options, int defaultIndex)
        {
            for (int index = 0; index < options.Count; index++)
            {
                Console.WriteLine("  " + (index + 1).ToString(CultureInfo.InvariantCulture).PadLeft(2) + ") " + options[index]);
            }

            return AskNumber(question, defaultIndex + 1, 1, options.Count) - 1;
        }
    }
}
