using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace KosherShell
{
    // מעטפת חלון אמיתית לעמדת שיעורים: מריצה את השרת המקומי ומציגה את הממשק במסך מלא.
    // יציאה מהתוכנה דורשת את סיסמת האחראי (כמו "אמון מלא" באיפיון).
    public class MainForm : Form
    {
        private readonly WebView2 _web;
        private readonly string _appDir;
        private readonly int _port;
        private readonly bool _isStation;
        private readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        private Process? _server;
        private bool _exitAuthorized;

        public MainForm(string appDir, int port, bool isStation)
        {
            _appDir = appDir;
            _port = port;
            _isStation = isStation;
            _web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(_web);

            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Maximized;
            KeyPreview = true;
            Text = "עמדת שיעורים";
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = true;
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try
            {
                await StartServerAsync();
                var env = await CoreWebView2Environment.CreateAsync(
                    userDataFolder: Path.Combine(_appDir, ".webview2"));
                await _web.EnsureCoreWebView2Async(env);
                _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.Source = new Uri($"http://127.0.0.1:{_port}/" + (_isStation ? "station" : ""));
            }
            catch (Exception ex)
            {
                Log("שגיאת אתחול: " + ex.Message);
                MessageBox.Show("שגיאת אתחול: " + ex.Message, "עמדת שיעורים", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        // הפעלת השרת המקומי (node server.js) והמתנה שיהיה זמין
        private async Task StartServerAsync()
        {
            var node = FindNode();
            if (node == null)
            {
                throw new Exception("לא נמצא Node.js — הניחו node.exe לצד התוכנה או התקינו Node.js.");
            }
            var psi = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "server.js",
                WorkingDirectory = _appDir,
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            psi.Environment["KOSHER_PORT"] = _port.ToString();
            _server = Process.Start(psi)!;
            _server.OutputDataReceived += (s, a) => { if (!string.IsNullOrEmpty(a.Data)) Log(a.Data); };
            _server.ErrorDataReceived += (s, a) => { if (!string.IsNullOrEmpty(a.Data)) Log(a.Data); };
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();

            for (var i = 0; i < 50; i++)
            {
                try
                {
                    var r = await _http.GetAsync($"http://127.0.0.1:{_port}/api/status");
                    if (r.IsSuccessStatusCode) return;
                }
                catch { }
                await Task.Delay(300);
            }
            throw new Exception("השרת המקומי לא עלה בזמן.");
        }

        private static string? FindNode()
        {
            var exeDir = Path.GetDirectoryName(Application.ExecutablePath) ?? "";
            var candidates = new[] { "node.exe", "node" };
            foreach (var c in candidates)
            {
                var p = Path.Combine(exeDir, c);
                if (File.Exists(p)) return p;
                p = Path.Combine(exeDir, "app", c);
                if (File.Exists(p)) return p;
            }
            // חיפוש ב-PATH
            try
            {
                var psi = new ProcessStartInfo("where", "node.exe")
                {
                    RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true
                };
                var proc = Process.Start(psi);
                if (proc != null)
                {
                    var line = proc.StandardOutput.ReadLine();
                    proc.WaitForExit(3000);
                    if (!string.IsNullOrEmpty(line) && File.Exists(line.Trim())) return line.Trim();
                }
            }
            catch { }
            return null;
        }

        // סגירה: דורש סיסמת אחראי (אם הוגדרה)
        protected override async void OnFormClosing(FormClosingEventArgs e)
        {
            if (_exitAuthorized)
            {
                base.OnFormClosing(e);
                return;
            }
            e.Cancel = true;
            var ok = await AskPasswordAsync();
            if (ok)
            {
                _exitAuthorized = true;
                Close();
            }
        }

        private async Task<bool> AskPasswordAsync()
        {
            using var dlg = new Form
            {
                Text = "יציאה מהתוכנה",
                FormBorderStyle = FormBorderStyle.FixedDialog,
                StartPosition = FormStartPosition.CenterScreen,
                Width = 360,
                Height = 180,
                Font = new System.Drawing.Font("Segoe UI", 11)
            };
            var lbl = new Label { Text = "יציאה מהתוכנה דורשת סיסמת אחראי:", Left = 20, Top = 20, Width = 300 };
            var box = new TextBox { Left = 20, Top = 55, Width = 300, UseSystemPasswordChar = true };
            var btn = new Button { Text = "יציאה", Left = 100, Top = 95, Width = 120, DialogResult = DialogResult.OK };
            var cancel = new Button { Text = "ביטול", Left = 230, Top = 95, Width = 90, DialogResult = DialogResult.Cancel };
            dlg.Controls.Add(lbl); dlg.Controls.Add(box); dlg.Controls.Add(btn); dlg.Controls.Add(cancel);
            dlg.AcceptButton = btn;
            dlg.CancelButton = cancel;
            dlg.KeyPreview = true;

            while (true)
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return false;
                var pw = box.Text;
                if (string.IsNullOrEmpty(pw))
                {
                    // לא הוגדרה סיסמה כלל — מאפשרים יציאה חופשית
                    var status = await GetStatusAsync();
                    if (status == null || !status.Value.TryGetProperty("hasPassword", out var h) || !h.GetBoolean())
                        return true;
                    MessageBox.Show(this, "נדרשת סיסמת אחראי כדי לצאת.", "עמדת שיעורים",
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    continue;
                }
                var okBody = JsonSerializer.Serialize(new { password = pw });
                try
                {
                    using var content = new StringContent(okBody, System.Text.Encoding.UTF8, "application/json");
                    using var resp = await _http.PostAsync($"http://127.0.0.1:{_port}/api/verify-master", content);
                    if (resp.IsSuccessStatusCode) return true;
                    MessageBox.Show(this, "סיסמה שגויה.", "עמדת שיעורים", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                catch
                {
                    MessageBox.Show(this, "לא ניתן ליצור קשר עם השרת המקומי.", "עמדת שיעורים",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return false;
                }
            }
        }

        private async Task<JsonElement?> GetStatusAsync()
        {
            try
            {
                using var resp = await _http.GetAsync($"http://127.0.0.1:{_port}/api/status");
                if (!resp.IsSuccessStatusCode) return null;
                var txt = await resp.Content.ReadAsStringAsync();
                return JsonSerializer.Deserialize<JsonElement>(txt);
            }
            catch { return null; }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            try
            {
                if (_server != null && !_server.HasExited)
                {
                    _server.Kill(entireProcessTree: true);
                    _server.WaitForExit(3000);
                }
            }
            catch { }
            base.OnFormClosed(e);
        }

        private static void Log(string msg)
        {
            try
            {
                var logPath = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath) ?? ".", "kosher-shell.log");
                File.AppendAllText(logPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {msg}{Environment.NewLine}");
            }
            catch { }
        }
    }
}
