using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Xml;
using MiiXRay.Model;

namespace MiiXRay.Sources
{
    /// <summary>Loads objects from an SAP MII server through the Catalog service (/XMII/Catalog):
    /// POST form-urlencoded, basic authentication, FatalError answers become exceptions.</summary>
    public sealed class CatalogSource : IObjectSource
    {
        private readonly Uri _catalogUri;
        private readonly string _userName;
        private readonly string _password;
        private readonly bool _acceptAnyCertificate;
        private readonly int _timeoutMilliseconds;

        public CatalogSource(string host, int port, bool useHttps, string userName, string password, bool acceptAnyCertificate)
        {
            UriBuilder builder = new UriBuilder(useHttps ? "https" : "http", host.Trim(), port, "/XMII/Catalog");
            _catalogUri = builder.Uri;
            _userName = userName;
            _password = password;
            _acceptAnyCertificate = acceptAnyCertificate;
            _timeoutMilliseconds = 120000;
        }

        public string Description
        {
            get { return "MII " + _catalogUri.Scheme + "://" + _catalogUri.Host + ":" + _catalogUri.Port + " as " + _userName; }
        }

        public void CheckConnection()
        {
            // Exists on a path that cannot exist: a working server answers with Message 0
            Exists("MiiXRay/ConnectionCheck/doesNotExist");
        }

        public LoadedObject Load(string objectPath)
        {
            string path = ObjectPath.Normalize(objectPath);
            if (path.Length == 0 || !Exists(path))
            {
                return null;
            }
            Dictionary<string, string> form = new Dictionary<string, string>();
            form.Add("Mode", "Load");
            form.Add("ObjectName", path);
            form.Add("Content-Type", "text/xml");
            form.Add("_", Guid.NewGuid().ToString());
            string text = Post(form);
            ThrowOnFatalError(text);
            LoadedObject result = new LoadedObject();
            result.CanonicalPath = path;
            result.Text = text;
            return result;
        }

        public List<string> FindSimilar(string objectPath, int maximum)
        {
            string path = ObjectPath.Normalize(objectPath);
            List<string> candidates = new List<string>();
            string folder = ObjectPath.Folder(path);
            while (folder.Length > 0 && candidates.Count == 0)
            {
                try
                {
                    candidates = ListObjects(folder);
                }
                catch (SourceException)
                {
                    candidates = new List<string>();
                }
                folder = ObjectPath.Folder(folder);
            }
            return SimilarNames.Find(candidates, path, maximum);
        }

        private bool Exists(string path)
        {
            Dictionary<string, string> form = new Dictionary<string, string>();
            form.Add("Mode", "Exists");
            form.Add("ObjectName", path);
            form.Add("Content-Type", "text/xml");
            form.Add("_", Guid.NewGuid().ToString());
            XmlDocument document = ParseAnswer(Post(form));
            XmlNodeList messages = document.GetElementsByTagName("Message");
            return messages.Count > 0 && messages[0].InnerText.Trim() == "1";
        }

        private List<string> ListObjects(string folder)
        {
            Dictionary<string, string> form = new Dictionary<string, string>();
            form.Add("Mode", "LoadFilesInsideFolderAndSubfolders");
            form.Add("Folder", folder);
            form.Add("Content-Type", "text/xml");
            XmlDocument document = ParseAnswer(Post(form));
            List<string> result = new List<string>();
            foreach (XmlNode row in document.GetElementsByTagName("Row"))
            {
                string filePath = MiiXml.ChildText(row, "FilePath").Trim().Trim('/');
                string objectName = MiiXml.ChildText(row, "ObjectName").Trim();
                if (objectName.Length > 0)
                {
                    result.Add(ObjectPath.Normalize(filePath.Length > 0 ? filePath + "/" + objectName : objectName));
                }
            }
            return result;
        }

        private XmlDocument ParseAnswer(string text)
        {
            XmlDocument document;
            try
            {
                document = MiiXml.Parse(text);
            }
            catch (XmlException exception)
            {
                throw new SourceException("The server answered with something that is not XML.",
                    "Check host and port: the profile must point at the MII server itself (not at a login page or proxy).", exception);
            }
            ThrowOnFatalError(document);
            return document;
        }

        private static void ThrowOnFatalError(string text)
        {
            if (text.IndexOf("FatalError", StringComparison.Ordinal) < 0)
            {
                return;
            }
            XmlDocument document = MiiXml.TryParse(text);
            if (document != null && document.DocumentElement != null && document.DocumentElement.LocalName == "Rowsets")
            {
                ThrowOnFatalError(document);
            }
        }

        private static void ThrowOnFatalError(XmlDocument document)
        {
            XmlNodeList fatal = document.GetElementsByTagName("FatalError");
            if (fatal.Count > 0)
            {
                throw new SourceException("MII reports: " + fatal[0].InnerText.Trim(),
                    "The user needs a role with access to the Catalog service (e.g. SAP_XMII_Developer) and read access to the project.");
            }
        }

        private string Post(Dictionary<string, string> form)
        {
            StringBuilder body = new StringBuilder();
            foreach (KeyValuePair<string, string> pair in form)
            {
                if (body.Length > 0)
                {
                    body.Append('&');
                }
                body.Append(pair.Key).Append('=').Append(Uri.EscapeDataString(pair.Value));
            }
            byte[] bytes = Encoding.UTF8.GetBytes(body.ToString());

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(_catalogUri);
            request.Method = "POST";
            request.ContentType = "application/x-www-form-urlencoded; charset=UTF-8";
            request.ContentLength = bytes.Length;
            request.Timeout = _timeoutMilliseconds;
            request.ReadWriteTimeout = _timeoutMilliseconds;
            request.Proxy = null;
            request.Headers[HttpRequestHeader.CacheControl] = "no-cache";
            string token = Convert.ToBase64String(Encoding.UTF8.GetBytes(_userName + ":" + _password));
            request.Headers[HttpRequestHeader.Authorization] = "Basic " + token;
            if (_acceptAnyCertificate)
            {
                request.ServerCertificateValidationCallback = AcceptAnyCertificate;
            }

            try
            {
                using (Stream stream = request.GetRequestStream())
                {
                    stream.Write(bytes, 0, bytes.Length);
                }
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (WebException exception)
            {
                throw Explain(exception);
            }
        }

        private static bool AcceptAnyCertificate(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors)
        {
            return true;
        }

        private SourceException Explain(WebException exception)
        {
            HttpWebResponse response = exception.Response as HttpWebResponse;
            if (response != null)
            {
                int status = (int)response.StatusCode;
                if (status == 401)
                {
                    return new SourceException("The server rejected the login (HTTP 401).",
                        "Check user name and password in the profile (choose 'Edit profile'). Locked users also answer 401.", exception);
                }
                if (status == 403)
                {
                    return new SourceException("The user may not use the Catalog service (HTTP 403).",
                        "Ask the MII administrator for a developer role (e.g. SAP_XMII_Developer) for this user.", exception);
                }
                if (status == 404)
                {
                    return new SourceException("The server has no /XMII/Catalog (HTTP 404).",
                        "Host or port point at something that is not SAP MII. Typical ports: 50000 (http) and 50001 (https).", exception);
                }
                return new SourceException("The server answered HTTP " + status + " " + response.StatusDescription + ".",
                    "Try again later or check the server log.", exception);
            }
            if (exception.Status == WebExceptionStatus.TrustFailure || exception.Status == WebExceptionStatus.SecureChannelFailure)
            {
                return new SourceException("The secure connection failed (" + exception.Status + ").",
                    "The server certificate is not trusted on this PC. Either install the certificate or edit the profile and allow untrusted certificates.", exception);
            }
            if (exception.Status == WebExceptionStatus.NameResolutionFailure)
            {
                return new SourceException("The host name " + _catalogUri.Host + " is unknown.",
                    "Check the host name in the profile and whether a VPN connection is needed.", exception);
            }
            if (exception.Status == WebExceptionStatus.Timeout)
            {
                return new SourceException("The server did not answer in time.",
                    "Check host, port and VPN; a firewall may drop the connection silently.", exception);
            }
            if (exception.Status == WebExceptionStatus.ConnectFailure)
            {
                return new SourceException("No connection to " + _catalogUri.Host + ":" + _catalogUri.Port + ".",
                    "Check host and port, http vs. https (50000 vs. 50001) and whether a VPN connection is needed.", exception);
            }
            return new SourceException("The request failed: " + exception.Message,
                "Check host, port, https setting and the network connection.", exception);
        }
    }
}
