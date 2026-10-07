using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Xml;

namespace MiiXRay.Model
{
    /// <summary>Small helpers over System.Xml for the MII export formats.</summary>
    public static class MiiXml
    {
        public const string XsiNamespace = "http://www.w3.org/2001/XMLSchema-instance";

        public static XmlDocument Parse(string text)
        {
            XmlDocument document = new XmlDocument();
            document.PreserveWhitespace = true;
            XmlReaderSettings settings = new XmlReaderSettings();
            settings.DtdProcessing = DtdProcessing.Prohibit;
            settings.XmlResolver = null;
            using (StringReader stringReader = new StringReader(text))
            using (XmlReader reader = XmlReader.Create(stringReader, settings))
            {
                document.Load(reader);
            }
            return document;
        }

        public static XmlElement Child(XmlNode parent, string name)
        {
            if (parent == null)
            {
                return null;
            }
            foreach (XmlNode node in parent.ChildNodes)
            {
                XmlElement element = node as XmlElement;
                if (element != null && element.LocalName == name)
                {
                    return element;
                }
            }
            return null;
        }

        public static List<XmlElement> Children(XmlNode parent, string name)
        {
            List<XmlElement> result = new List<XmlElement>();
            if (parent == null)
            {
                return result;
            }
            foreach (XmlNode node in parent.ChildNodes)
            {
                XmlElement element = node as XmlElement;
                if (element != null && element.LocalName == name)
                {
                    result.Add(element);
                }
            }
            return result;
        }

        public static List<XmlElement> ChildElements(XmlNode parent)
        {
            List<XmlElement> result = new List<XmlElement>();
            if (parent == null)
            {
                return result;
            }
            foreach (XmlNode node in parent.ChildNodes)
            {
                XmlElement element = node as XmlElement;
                if (element != null)
                {
                    result.Add(element);
                }
            }
            return result;
        }

        /// <summary>The text of a child element, or "" when the child does not exist.</summary>
        public static string ChildText(XmlNode parent, string name)
        {
            XmlElement child = Child(parent, name);
            return child == null ? string.Empty : child.InnerText;
        }

        public static string XsiType(XmlElement element)
        {
            if (element == null)
            {
                return string.Empty;
            }
            string value = element.GetAttribute("type", XsiNamespace);
            int colon = value.IndexOf(':');
            return colon >= 0 ? value.Substring(colon + 1) : value;
        }

        /// <summary>The direct text of an element without the text of its child elements. MII writes xml values as
        /// &lt;ReferenceDocumentSource/&gt; followed by the escaped document text.</summary>
        public static string OwnText(XmlElement element)
        {
            if (element == null)
            {
                return string.Empty;
            }
            StringBuilder text = new StringBuilder();
            foreach (XmlNode node in element.ChildNodes)
            {
                if (node.NodeType == XmlNodeType.Text || node.NodeType == XmlNodeType.CDATA
                    || node.NodeType == XmlNodeType.Whitespace || node.NodeType == XmlNodeType.SignificantWhitespace)
                {
                    text.Append(node.Value);
                }
            }
            return text.ToString();
        }

        /// <summary>Parses a document embedded as text; returns null when the text is empty or not well-formed.</summary>
        public static XmlDocument TryParse(string text)
        {
            if (text == null || text.Trim().Length == 0)
            {
                return null;
            }
            try
            {
                return Parse(text.Trim());
            }
            catch (XmlException)
            {
                return null;
            }
        }
    }
}
