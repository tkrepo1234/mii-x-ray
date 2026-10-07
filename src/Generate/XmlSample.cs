using System.Collections.Generic;
using System.Globalization;
using System.Xml;
using MiiXRay.Model;

namespace MiiXRay.Generate
{
    /// <summary>Default documents of MII properties are often complete test documents. X-Ray keeps their structure:
    /// of the child elements with the same name only the first two stay, followed by a comment with the number left out.
    /// XSLT stylesheets are left alone (equally named elements are logic there).</summary>
    public static class XmlSample
    {
        private const string XslNamespace = "http://www.w3.org/1999/XSL/Transform";
        private const int Kept = 2;

        public static string Shrink(string text)
        {
            XmlDocument document = MiiXml.TryParse(text);

            if (document == null || document.DocumentElement == null || document.DocumentElement.NamespaceURI == XslNamespace)
            {
                return text;
            }

            if (!Collapse(document.DocumentElement))
            {
                return text;
            }

            return document.OuterXml;
        }

        private static bool Collapse(XmlElement element)
        {
            bool changed = false;
            Dictionary<string, int> seen = new Dictionary<string, int>();
            Dictionary<string, XmlElement> lastKept = new Dictionary<string, XmlElement>();
            Dictionary<string, int> removed = new Dictionary<string, int>();
            List<XmlElement> children = MiiXml.ChildElements(element);

            foreach (XmlElement child in children)
            {
                int count;
                seen.TryGetValue(child.Name, out count);
                seen[child.Name] = count + 1;

                if (count < Kept)
                {
                    lastKept[child.Name] = child;
                    continue;
                }

                XmlNode before = child.PreviousSibling;

                if (before != null && (before.NodeType == XmlNodeType.Whitespace || before.NodeType == XmlNodeType.SignificantWhitespace))
                {
                    element.RemoveChild(before);
                }

                element.RemoveChild(child);
                int dropped;
                removed.TryGetValue(child.Name, out dropped);
                removed[child.Name] = dropped + 1;
                changed = true;
            }

            foreach (KeyValuePair<string, int> pair in removed)
            {
                string note = string.Format(CultureInfo.InvariantCulture, " X-Ray: {0} more <{1}> element{2} ", pair.Value, pair.Key, pair.Value == 1 ? string.Empty : "s");
                element.InsertAfter(element.OwnerDocument.CreateComment(note), lastKept[pair.Key]);
            }

            foreach (XmlElement child in MiiXml.ChildElements(element))
            {
                changed = Collapse(child) || changed;
            }

            return changed;
        }
    }
}
