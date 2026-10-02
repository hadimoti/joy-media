using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace JoyMedia.Setup
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool silent = false;
            foreach (string arg in args)
            {
                if (arg.Equals("/s", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("-s", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("--silent", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("-silent", StringComparison.OrdinalIgnoreCase))
                {
                    silent = true;
                }
            }

            if (silent)
            {
                InstallerEngine.InstallSync();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }

    public static class InstallerEngine
    {
        /// <summary>Single source of truth for the installer's product version. Keep in sync with
        /// the payload archive name passed to build-installer.ps1 (-Version).</summary>
        public const string ProductVersion = "1.0.1";

        public static string GetInstallPath()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(localAppData, "Programs", "JOY Media");
        }

        public static void InstallSync(Action<int, string> progressCallback = null)
        {
            string installPath = GetInstallPath();

            if (progressCallback != null) progressCallback(5, "Preparing installation directory...");
            if (!Directory.Exists(installPath))
            {
                Directory.CreateDirectory(installPath);
            }

            if (progressCallback != null) progressCallback(15, "Extracting application components...");
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream resourceStream = asm.GetManifestResourceStream("payload.zip"))
            {
                if (resourceStream == null)
                {
                    throw new InvalidOperationException("Installer payload not found in assembly resources.");
                }

                using (ZipArchive archive = new ZipArchive(resourceStream, ZipArchiveMode.Read))
                {
                    string installRoot = Path.GetFullPath(installPath)
                        .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                        + Path.DirectorySeparatorChar;
                    int count = archive.Entries.Count;
                    int i = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string rel = entry.FullName;
                        if (rel.StartsWith("joy-media-win32-x64/", StringComparison.OrdinalIgnoreCase))
                        {
                            rel = rel.Substring("joy-media-win32-x64/".Length);
                        }
                        else if (rel.StartsWith("joy-media-win32-x64\\", StringComparison.OrdinalIgnoreCase))
                        {
                            rel = rel.Substring("joy-media-win32-x64\\".Length);
                        }
                        if (string.IsNullOrEmpty(rel))
                        {
                            continue;
                        }

                        string destPath = Path.GetFullPath(Path.Combine(installPath, rel));
                        if (!destPath.StartsWith(installRoot, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidOperationException(
                                "Installer payload entry escapes the install directory: " + entry.FullName);
                        }
                        if (string.IsNullOrEmpty(entry.Name) || rel.EndsWith("/") || rel.EndsWith("\\"))
                        {
                            Directory.CreateDirectory(destPath);
                        }
                        else
                        {
                            string dir = Path.GetDirectoryName(destPath);
                            if (!Directory.Exists(dir))
                            {
                                Directory.CreateDirectory(dir);
                            }
                            entry.ExtractToFile(destPath, true);
                        }
                        i++;
                        if (progressCallback != null && count > 0 && i % 10 == 0)
                        {
                            int pct = 15 + (int)((float)i / count * 70);
                            progressCallback(pct, string.Format("Extracting {0}...", entry.Name));
                        }
                    }
                }
            }

            if (progressCallback != null) progressCallback(90, "Creating shortcuts...");
            CreateShortcuts(installPath);

            if (progressCallback != null) progressCallback(95, "Registering PATH and uninstaller...");
            RegisterUserPath(installPath);
            RegisterUninstaller(installPath);

            if (progressCallback != null) progressCallback(100, "Installation complete!");
        }

        private static void CreateShortcuts(string installPath)
        {
            try
            {
                string exePath = Path.Combine(installPath, "joy-media.exe");
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                dynamic shell = Activator.CreateInstance(shellType);

                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string desktopLnk = Path.Combine(desktop, "JOY Media.lnk");
                dynamic shortcut1 = shell.CreateShortcut(desktopLnk);
                shortcut1.TargetPath = exePath;
                shortcut1.WorkingDirectory = installPath;
                shortcut1.Description = "JOY Media Desktop Application";
                shortcut1.Save();

                string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Microsoft", "Windows", "Start Menu", "Programs");
                string startMenuLnk = Path.Combine(startMenu, "JOY Media.lnk");
                dynamic shortcut2 = shell.CreateShortcut(startMenuLnk);
                shortcut2.TargetPath = exePath;
                shortcut2.WorkingDirectory = installPath;
                shortcut2.Description = "JOY Media Desktop Application";
                shortcut2.Save();
            }
            catch { }
        }

        private static void RegisterUserPath(string installPath)
        {
            try
            {
                using (RegistryKey envKey = Registry.CurrentUser.OpenSubKey("Environment", true))
                {
                    if (envKey != null)
                    {
                        string path = envKey.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string ?? "";
                        string[] parts = path.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
                        bool exists = false;
                        foreach (string p in parts)
                        {
                            if (p.Trim().Equals(installPath, StringComparison.OrdinalIgnoreCase))
                            {
                                exists = true;
                                break;
                            }
                        }
                        if (!exists)
                        {
                            string newPath = string.IsNullOrEmpty(path) ? installPath : path + ";" + installPath;
                            envKey.SetValue("Path", newPath, RegistryValueKind.ExpandString);
                        }
                    }
                }
            }
            catch { }
        }

        private static void RegisterUninstaller(string installPath)
        {
            try
            {
                string keyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\JoyMedia";
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(keyPath))
                {
                    if (key != null)
                    {
                        string exePath = Path.Combine(installPath, "joy-media.exe");
                        string uninstallCmd = Path.Combine(installPath, "uninstall.cmd");
                        key.SetValue("DisplayName", "JOY Media", RegistryValueKind.String);
                        key.SetValue("DisplayVersion", InstallerEngine.ProductVersion, RegistryValueKind.String);
                        key.SetValue("Publisher", "JOY Team", RegistryValueKind.String);
                        key.SetValue("DisplayIcon", exePath, RegistryValueKind.String);
                        key.SetValue("InstallLocation", installPath, RegistryValueKind.String);
                        key.SetValue("UninstallString", "\"" + uninstallCmd + "\"", RegistryValueKind.String);
                    }
                }
            }
            catch { }
        }
    }

    public class InstallerForm : Form
    {
        private ProgressBar progressBar;
        private Label statusLabel;
        private Label titleLabel;
        private Label subtitleLabel;
        private Button actionButton;
        private CheckBox launchCheckbox;

        public InstallerForm()
        {
            InitializeComponent();
            this.Load += InstallerForm_Load;
        }

        private void InitializeComponent()
        {
            this.Text = "JOY Media Setup";
            this.Size = new Size(520, 290);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(18, 18, 20);
            this.ForeColor = Color.White;

            titleLabel = new Label
            {
                Text = "JOY Media v" + InstallerEngine.ProductVersion,
                Font = new Font("Segoe UI", 16, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 210, 255),
                Location = new Point(24, 20),
                AutoSize = true
            };

            subtitleLabel = new Label
            {
                Text = "100% Offline-First Professional Desktop NLE & Creative AI Studio",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = Color.FromArgb(180, 180, 190),
                Location = new Point(26, 56),
                AutoSize = true
            };

            statusLabel = new Label
            {
                Text = "Ready to install...",
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(220, 220, 230),
                Location = new Point(26, 105),
                Size = new Size(450, 22)
            };

            progressBar = new ProgressBar
            {
                Location = new Point(26, 132),
                Size = new Size(452, 22),
                Minimum = 0,
                Maximum = 100,
                Value = 0
            };

            launchCheckbox = new CheckBox
            {
                Text = "Launch JOY Media after setup completes",
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(200, 200, 210),
                Location = new Point(26, 172),
                AutoSize = true,
                Checked = true,
                Visible = false
            };

            actionButton = new Button
            {
                Text = "Install Now",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                BackColor = Color.FromArgb(0, 150, 255),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Location = new Point(360, 205),
                Size = new Size(118, 34)
            };
            actionButton.FlatAppearance.BorderSize = 0;
            actionButton.Click += ActionButton_Click;

            this.Controls.Add(titleLabel);
            this.Controls.Add(subtitleLabel);
            this.Controls.Add(statusLabel);
            this.Controls.Add(progressBar);
            this.Controls.Add(launchCheckbox);
            this.Controls.Add(actionButton);
        }

        private async void InstallerForm_Load(object sender, EventArgs e)
        {
            await StartInstallAsync();
        }

        private async void ActionButton_Click(object sender, EventArgs e)
        {
            if (actionButton.Text == "Close" || actionButton.Text == "Finish")
            {
                if (launchCheckbox.Checked)
                {
                    try
                    {
                        string exePath = Path.Combine(InstallerEngine.GetInstallPath(), "joy-media.exe");
                        if (File.Exists(exePath))
                        {
                            System.Diagnostics.Process.Start(exePath);
                        }
                    }
                    catch { }
                }
                this.Close();
            }
            else
            {
                await StartInstallAsync();
            }
        }

        private async Task StartInstallAsync()
        {
            actionButton.Enabled = false;
            actionButton.Text = "Installing...";

            try
            {
                await Task.Run(() =>
                {
                    InstallerEngine.InstallSync((pct, text) =>
                    {
                        this.Invoke(new Action(() =>
                        {
                            progressBar.Value = Math.Min(100, Math.Max(0, pct));
                            statusLabel.Text = text;
                        }));
                    });
                });

                progressBar.Value = 100;
                statusLabel.Text = "JOY Media installed successfully!";
                statusLabel.ForeColor = Color.FromArgb(16, 185, 129);
                launchCheckbox.Visible = true;
                actionButton.Text = "Finish";
                actionButton.Enabled = true;
                actionButton.BackColor = Color.FromArgb(16, 185, 129);
            }
            catch (Exception ex)
            {
                statusLabel.Text = "Installation failed: " + ex.Message;
                statusLabel.ForeColor = Color.FromArgb(239, 68, 68);
                actionButton.Text = "Close";
                actionButton.Enabled = true;
            }
        }
    }
}
