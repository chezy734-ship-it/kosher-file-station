using System;
using System.IO;
using System.Windows.Forms;

namespace KosherShell
{
    internal static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            // קלול ארגומנטים: --station / --explorer / --port N / --appdir PATH
            bool isStation = false;
            int port = 8787;
            string? appDir = null;
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i].ToLowerInvariant())
                {
                    case "--station": isStation = true; break;
                    case "--explorer": isStation = false; break;
                    case "--port":
                        if (i + 1 < args.Length && int.TryParse(args[++i], out var p)) port = p;
                        break;
                    case "--appdir":
                        if (i + 1 < args.Length) appDir = args[++i];
                        break;
                }
            }

            if (appDir == null)
            {
                var exeDir = Path.GetDirectoryName(Application.ExecutablePath) ?? ".";
                // החיפוש: לצד ה-exe, בתיקיית app, או בספריית האב
                foreach (var candidate in new[]
                {
                    Path.Combine(exeDir, "server.js"),
                    Path.Combine(exeDir, "app", "server.js"),
                    Path.Combine(exeDir, "..", "server.js")
                })
                {
                    if (File.Exists(candidate))
                    {
                        appDir = Path.GetDirectoryName(candidate);
                        break;
                    }
                }
            }

            if (appDir == null || !File.Exists(Path.Combine(appDir, "server.js")))
            {
                MessageBox.Show("לא נמצאה תיקיית התוכנה (server.js). הניחו את התוכנה לצד קובץ ההרצה.",
                    "עמדת שיעורים", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(appDir, port, isStation));
        }
    }
}
