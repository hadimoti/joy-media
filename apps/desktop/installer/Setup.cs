using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
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
            bool rollback = false;
            bool restoreData = false;
            foreach (string arg in args)
            {
                if (IsArgument(arg, "/s", "-s", "--silent", "-silent")) silent = true;
                else if (IsArgument(arg, "/rollback", "--rollback")) rollback = true;
                else if (IsArgument(arg, "/restore-data", "--restore-data")) restoreData = true;
            }

            if (rollback)
            {
                try
                {
                    InstallerEngine.RollbackSync(restoreData);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("JOY Media rollback failed: " + ex.Message);
                    Environment.ExitCode = 1;
                }
                return;
            }

            if (silent)
            {
                try
                {
                    InstallerEngine.InstallSync(null);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("JOY Media setup failed: " + ex.Message);
                    Environment.ExitCode = 1;
                }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }

        private static bool IsArgument(string arg, params string[] names)
        {
            foreach (string name in names)
            {
                if (arg.Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }
    }

    public static class InstallerEngine
    {
        /// <summary>Single source of truth for the installer's product version. Keep in sync with
        /// the payload archive name passed to build-installer.ps1 (-Version).</summary>
        public const string ProductVersion = "1.0.3";

        private const string InstallFolderName = "JOY Media";
        private const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\JoyMedia";
        private const string PayloadArchiveName = "payload.zip";
        private const string PayloadManifestName = "payload-manifest.txt";
        private const string PayloadRoot = "joy-media-win32-x64/";
        private const string PayloadRootBackslash = "joy-media-win32-x64\\";
        private const string ShortcutDescription = "JOY Media Desktop Application";
        private static readonly string[] DatabaseFiles = { "joy-media.sqlite3", "joy-media.sqlite3-wal", "joy-media.sqlite3-shm" };
        private static readonly Regex ManifestLine = new Regex("^([0-9a-f]{64})  (.+)$");

        public static string GetInstallPath()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(localAppData, "Programs", InstallFolderName);
        }

        /// <summary>The version an update kept beside the installed one. Rollback puts it back.</summary>
        public static string GetPreviousPath()
        {
            return GetInstallPath() + ".previous";
        }

        private static string GetStagingPath()
        {
            return GetInstallPath() + ".staging-" + SafeName(ProductVersion);
        }

        private static string GetRollbackTempPath()
        {
            return GetInstallPath() + ".rollback-tmp";
        }

        /// <summary>Installs the payload. The new files are extracted and checked against the embedded manifest in a
        /// staging folder first. An installed version is then replaced by moving it aside, so it is kept for rollback.
        /// Any failure before the move leaves the installed version untouched.</summary>
        public static void InstallSync(Action<int, string> progressCallback)
        {
            string installPath = GetInstallPath();
            string stagingPath = GetStagingPath();
            Dictionary<string, string> manifest = ReadPayloadManifest();
            bool replacing = Directory.Exists(installPath);
            string replacedVersion = replacing ? (ReadRegisteredValue("DisplayVersion") ?? "unknown") : null;
            // A repair reinstalls the installed version. It keeps the version an earlier update left as the previous one.
            bool repairing = replacing && string.Equals(replacedVersion, ProductVersion, StringComparison.OrdinalIgnoreCase);

            Report(progressCallback, 5, "Preparing the installation...");
            string leftover = TryDeleteDirectory(stagingPath);
            if (leftover != null)
            {
                throw new InvalidOperationException("A leftover staging folder could not be removed: " + leftover);
            }

            try
            {
                Report(progressCallback, 15, "Extracting application components...");
                ExtractPayload(stagingPath, progressCallback);
                Report(progressCallback, 72, "Checking every file against the installer manifest...");
                VerifyStaging(stagingPath, manifest);
                if (replacing)
                {
                    Report(progressCallback, 78, "Saving your local database before the update...");
                    SnapshotDatabase(GetUserDataDirectory(installPath), replacedVersion);
                    Report(progressCallback, 84, "Replacing the installed version...");
                    SwapIn(installPath, stagingPath, !repairing);
                }
                else
                {
                    Report(progressCallback, 84, "Placing the application...");
                    MoveDirectory(stagingPath, installPath);
                }
            }
            catch (Exception failure)
            {
                string partial = TryDeleteDirectory(stagingPath);
                if (partial == null)
                {
                    throw;
                }
                throw new InvalidOperationException(failure.Message + " The partial update could not be removed: " + partial, failure);
            }

            Report(progressCallback, 90, "Creating shortcuts...");
            CreateShortcuts(installPath);
            Report(progressCallback, 95, "Registering PATH and uninstaller...");
            RegisterUserPath(installPath);
            RegisterUninstaller(installPath, repairing ? ReadRegisteredValue("PreviousVersion") : (replacing ? replacedVersion : null));
            Report(progressCallback, 100, "Installation complete!");
        }

        /// <summary>Puts back the version an update kept beside the installed one. The version it replaces is kept in its
        /// place, so a rollback can be undone. Saved database files are restored only when asked for.</summary>
        public static void RollbackSync(bool restoreData)
        {
            string installPath = GetInstallPath();
            string previousPath = GetPreviousPath();
            if (!File.Exists(Path.Combine(previousPath, "joy-media.exe")))
            {
                throw new InvalidOperationException("There is no kept previous version to roll back to.");
            }
            string currentVersion = ReadRegisteredValue("DisplayVersion") ?? "unknown";
            string restoredVersion = ReadRegisteredValue("PreviousVersion");
            if (string.IsNullOrEmpty(restoredVersion))
            {
                throw new InvalidOperationException("The kept previous version is not recorded, so the rollback was not started.");
            }

            string userDataDirectory = GetUserDataDirectory(previousPath);
            string snapshot = SnapshotFolder(userDataDirectory, restoredVersion);
            if (restoreData && !File.Exists(Path.Combine(snapshot, DatabaseFiles[0])))
            {
                throw new InvalidOperationException("No saved database exists for version " + restoredVersion + ", so the rollback was not started.");
            }

            string tempPath = GetRollbackTempPath();
            string leftover = TryDeleteDirectory(tempPath);
            if (leftover != null)
            {
                throw new InvalidOperationException("A leftover rollback folder could not be removed: " + leftover);
            }

            MoveDirectory(installPath, tempPath);
            try
            {
                MoveDirectory(previousPath, installPath);
            }
            catch (Exception failure)
            {
                Directory.Move(tempPath, installPath);
                throw new InvalidOperationException("The kept version could not be placed, so the current version was kept. " + failure.Message, failure);
            }

            WriteRegisteredVersions(restoredVersion, currentVersion);
            try
            {
                Directory.Move(tempPath, previousPath);
            }
            catch (Exception failure)
            {
                throw new InvalidOperationException("Rolled back to " + restoredVersion + ", but the replaced version could not be kept: " + failure.Message, failure);
            }

            if (restoreData)
            {
                SnapshotDatabase(userDataDirectory, currentVersion);
                RestoreDatabase(snapshot, userDataDirectory);
            }
        }

        private static void ExtractPayload(string stagingPath, Action<int, string> progressCallback)
        {
            string root = FullRoot(stagingPath);
            Directory.CreateDirectory(stagingPath);
            using (Stream resourceStream = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadArchiveName))
            {
                if (resourceStream == null)
                {
                    throw new InvalidOperationException("Installer payload not found in assembly resources.");
                }

                using (ZipArchive archive = new ZipArchive(resourceStream, ZipArchiveMode.Read))
                {
                    int count = archive.Entries.Count;
                    int i = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string rel = RelativeEntryPath(entry.FullName);
                        if (string.IsNullOrEmpty(rel))
                        {
                            continue;
                        }

                        string destPath = Path.GetFullPath(Path.Combine(stagingPath, rel));
                        if (!destPath.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidOperationException("Installer payload entry escapes the install directory: " + entry.FullName);
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
                            int pct = 15 + (int)((float)i / count * 55);
                            progressCallback(pct, string.Format("Extracting {0}...", entry.Name));
                        }
                    }
                }
            }
        }

        private static string RelativeEntryPath(string entryName)
        {
            if (entryName.StartsWith(PayloadRoot, StringComparison.OrdinalIgnoreCase))
            {
                return entryName.Substring(PayloadRoot.Length);
            }
            if (entryName.StartsWith(PayloadRootBackslash, StringComparison.OrdinalIgnoreCase))
            {
                return entryName.Substring(PayloadRootBackslash.Length);
            }
            return entryName;
        }

        /// <summary>Every file in staging must be listed in the embedded manifest, match its digest, and no listed file
        /// may be missing. A damaged or altered package stops here, before anything installed is touched.</summary>
        private static void VerifyStaging(string stagingPath, Dictionary<string, string> manifest)
        {
            int seen = 0;
            foreach (string file in Directory.GetFiles(stagingPath, "*", SearchOption.AllDirectories))
            {
                string rel = RelativePath(stagingPath, file);
                string expected;
                if (!manifest.TryGetValue(rel, out expected))
                {
                    throw new InvalidOperationException("The package holds a file its manifest does not list: " + rel);
                }
                if (!Sha256Hex(file).Equals(expected, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("The package file does not match its manifest: " + rel);
                }
                seen++;
            }
            if (seen != manifest.Count)
            {
                throw new InvalidOperationException(string.Format("The package holds {0} files, but its manifest lists {1}.", seen, manifest.Count));
            }
        }

        private static Dictionary<string, string> ReadPayloadManifest()
        {
            Dictionary<string, string> entries = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadManifestName))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("Installer manifest not found in assembly resources.");
                }
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal))
                        {
                            continue;
                        }
                        Match match = ManifestLine.Match(line);
                        if (!match.Success)
                        {
                            throw new InvalidOperationException("The installer manifest has a malformed line.");
                        }
                        string rel = match.Groups[2].Value;
                        if (!IsSafeRelativePath(rel))
                        {
                            throw new InvalidOperationException("The installer manifest names an unsafe path.");
                        }
                        if (entries.ContainsKey(rel))
                        {
                            throw new InvalidOperationException("The installer manifest lists a file twice.");
                        }
                        entries[rel] = match.Groups[1].Value;
                    }
                }
            }
            if (entries.Count == 0)
            {
                throw new InvalidOperationException("The installer manifest lists no files.");
            }
            return entries;
        }

        private static bool IsSafeRelativePath(string rel)
        {
            if (rel.Length == 0 || rel.StartsWith("/", StringComparison.Ordinal) || rel.Contains("\\"))
            {
                return false;
            }
            foreach (string part in rel.Split('/'))
            {
                if (part.Length == 0 || part == "." || part == "..")
                {
                    return false;
                }
            }
            return true;
        }

        /// <summary>Replaces the installed version with the staged one. An update keeps the version it replaces as the
        /// previous version, and removes the older previous version only after the update has succeeded. A repair moves
        /// the installed files aside and keeps the previous version as it was. If the installed version cannot be moved,
        /// nothing has changed.</summary>
        private static void SwapIn(string installPath, string stagingPath, bool keepPrevious)
        {
            string previousPath = GetPreviousPath();
            string retiredPath = previousPath + "-retired";
            string replacedPath = installPath + ".replaced";
            ThrowIfLeftover(retiredPath);
            ThrowIfLeftover(replacedPath);

            bool hadPrevious = keepPrevious && Directory.Exists(previousPath);
            if (hadPrevious)
            {
                MoveDirectory(previousPath, retiredPath);
            }
            string target = keepPrevious ? previousPath : replacedPath;
            try
            {
                MoveDirectory(installPath, target);
            }
            catch (Exception)
            {
                if (hadPrevious)
                {
                    MoveDirectory(retiredPath, previousPath);
                }
                throw;
            }
            try
            {
                MoveDirectory(stagingPath, installPath);
            }
            catch (Exception failure)
            {
                Directory.Move(target, installPath);
                if (hadPrevious)
                {
                    Directory.Move(retiredPath, previousPath);
                }
                throw new InvalidOperationException("The new version could not be placed, so the installed version was kept. " + failure.Message, failure);
            }

            string removal = TryDeleteDirectory(keepPrevious ? retiredPath : replacedPath);
            if (removal != null)
            {
                throw new InvalidOperationException("The update is in place, but the version it replaced could not be removed: " + removal);
            }
        }

        private static void ThrowIfLeftover(string path)
        {
            string leftover = TryDeleteDirectory(path);
            if (leftover != null)
            {
                throw new InvalidOperationException("A leftover folder could not be removed: " + leftover);
            }
        }

        private static void MoveDirectory(string source, string destination)
        {
            try
            {
                Directory.Move(source, destination);
            }
            catch (IOException ex)
            {
                throw InUse(ex);
            }
            catch (UnauthorizedAccessException ex)
            {
                throw InUse(ex);
            }
        }

        private static InvalidOperationException InUse(Exception cause)
        {
            return new InvalidOperationException(
                "JOY Media is in use. Close it, then run setup again. The installed version was not changed.", cause);
        }

        /// <summary>Electron's default data folder for the installed app: its name under the roaming AppData folder.
        /// If the install does not name itself, the update is refused rather than guessing where the data is.</summary>
        private static string GetUserDataDirectory(string appRoot)
        {
            string packagePath = Path.Combine(appRoot, "resources", "app", "package.json");
            string name = null;
            if (File.Exists(packagePath))
            {
                string json = File.ReadAllText(packagePath);
                Match productName = Regex.Match(json, "\"productName\"\\s*:\\s*\"([^\"]+)\"");
                Match packageName = Regex.Match(json, "\"name\"\\s*:\\s*\"([^\"]+)\"");
                if (productName.Success)
                {
                    name = productName.Groups[1].Value;
                }
                else if (packageName.Success)
                {
                    name = packageName.Groups[1].Value;
                }
            }
            if (string.IsNullOrEmpty(name))
            {
                throw new InvalidOperationException("The installed version does not name its data folder, so the update was refused to keep your data safe.");
            }
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, name.Replace('/', Path.DirectorySeparatorChar));
        }

        private static string SnapshotFolder(string userDataDirectory, string version)
        {
            return Path.Combine(userDataDirectory, "backups", "pre-update-" + SafeName(version));
        }

        private static void SnapshotDatabase(string userDataDirectory, string fromVersion)
        {
            if (!File.Exists(Path.Combine(userDataDirectory, DatabaseFiles[0])))
            {
                return; // A fresh profile has no database to keep.
            }
            string target = SnapshotFolder(userDataDirectory, fromVersion);
            try
            {
                Directory.CreateDirectory(target);
                foreach (string name in DatabaseFiles)
                {
                    string source = Path.Combine(userDataDirectory, name);
                    if (File.Exists(source))
                    {
                        File.Copy(source, Path.Combine(target, name), true);
                    }
                }
            }
            catch (IOException ex)
            {
                throw new InvalidOperationException("Your local database could not be saved before the update, so the update was refused. Close JOY Media, then run setup again.", ex);
            }
            catch (UnauthorizedAccessException ex)
            {
                throw new InvalidOperationException("Your local database could not be saved before the update, so the update was refused. Close JOY Media, then run setup again.", ex);
            }
        }

        private static void RestoreDatabase(string snapshotDirectory, string userDataDirectory)
        {
            try
            {
                foreach (string name in DatabaseFiles)
                {
                    string source = Path.Combine(snapshotDirectory, name);
                    string target = Path.Combine(userDataDirectory, name);
                    if (File.Exists(source))
                    {
                        File.Copy(source, target, true);
                    }
                    else if (File.Exists(target))
                    {
                        // A write-ahead log from the newer version must not stay beside an older database.
                        File.Delete(target);
                    }
                }
            }
            catch (IOException ex)
            {
                throw new InvalidOperationException("The saved database could not be restored: " + ex.Message, ex);
            }
            catch (UnauthorizedAccessException ex)
            {
                throw new InvalidOperationException("The saved database could not be restored: " + ex.Message, ex);
            }
        }

        private static void CreateShortcuts(string installPath)
        {
            string exePath = Path.Combine(installPath, "joy-media.exe");
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
            {
                throw new InvalidOperationException("The shortcuts could not be created because WScript.Shell is unavailable.");
            }
            dynamic shell = Activator.CreateInstance(shellType);

            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            WriteShortcut(shell, Path.Combine(desktop, "JOY Media.lnk"), exePath, installPath);

            string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Microsoft", "Windows", "Start Menu", "Programs");
            WriteShortcut(shell, Path.Combine(startMenu, "JOY Media.lnk"), exePath, installPath);
        }

        private static void WriteShortcut(dynamic shell, string shortcutPath, string targetPath, string workingDirectory)
        {
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = targetPath;
            shortcut.WorkingDirectory = workingDirectory;
            shortcut.Description = ShortcutDescription;
            shortcut.Save();
        }

        private static void RegisterUserPath(string installPath)
        {
            // Only the bin folder goes on PATH: the install root holds joy-media.exe (the GUI), and Windows
            // tries .EXE before .CMD. An earlier install listed the root, so that entry is removed.
            // A failure is not swallowed: without the entry the commands are not registered.
            string binPath = Path.Combine(installPath, "bin");
            using (RegistryKey envKey = Registry.CurrentUser.OpenSubKey("Environment", true))
            {
                if (envKey == null)
                {
                    throw new InvalidOperationException("The user PATH could not be opened, so the commands were not registered.");
                }
                string path = envKey.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string ?? "";
                string[] parts = path.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
                List<string> updated = new List<string>();
                foreach (string p in parts)
                {
                    if (!p.Trim().Equals(installPath, StringComparison.OrdinalIgnoreCase)) updated.Add(p);
                }
                bool hasBin = updated.Exists(p => p.Trim().Equals(binPath, StringComparison.OrdinalIgnoreCase));
                if (!hasBin) updated.Add(binPath);
                string newPath = string.Join(";", updated.ToArray());
                if (!newPath.Equals(string.Join(";", parts), StringComparison.Ordinal))
                {
                    envKey.SetValue("Path", newPath, RegistryValueKind.ExpandString);
                }
            }
        }

        /// <summary>Apps and features removes JOY Media through this key, so a failure to write it is not swallowed.
        /// A version that replaced an installed one is recorded as the kept previous version.</summary>
        private static void RegisterUninstaller(string installPath, string replacedVersion)
        {
            string exePath = Path.Combine(installPath, "joy-media.exe");
            string uninstallCmd = Path.Combine(installPath, "uninstall.cmd");
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKeyPath))
            {
                if (key == null)
                {
                    throw new InvalidOperationException("The uninstall registration could not be created.");
                }
                key.SetValue("DisplayName", "JOY Media", RegistryValueKind.String);
                key.SetValue("Publisher", "JOY Team", RegistryValueKind.String);
                key.SetValue("DisplayIcon", exePath, RegistryValueKind.String);
                key.SetValue("InstallLocation", installPath, RegistryValueKind.String);
                key.SetValue("UninstallString", "\"" + uninstallCmd + "\"", RegistryValueKind.String);
            }
            WriteRegisteredVersions(ProductVersion, replacedVersion);
        }

        private static void WriteRegisteredVersions(string displayVersion, string previousVersion)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKeyPath))
            {
                if (key == null)
                {
                    throw new InvalidOperationException("The uninstall registration could not be opened.");
                }
                key.SetValue("DisplayVersion", displayVersion, RegistryValueKind.String);
                if (string.IsNullOrEmpty(previousVersion))
                {
                    key.DeleteValue("PreviousVersion", false);
                }
                else
                {
                    key.SetValue("PreviousVersion", previousVersion, RegistryValueKind.String);
                }
            }
        }

        private static string ReadRegisteredValue(string name)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKeyPath))
            {
                return key == null ? null : key.GetValue(name) as string;
            }
        }

        private static void DeleteDirectory(string path)
        {
            if (!Directory.Exists(path))
            {
                return;
            }
            foreach (string file in Directory.GetFiles(path, "*", SearchOption.AllDirectories))
            {
                File.SetAttributes(file, FileAttributes.Normal);
            }
            Directory.Delete(path, true);
        }

        /// <summary>Returns null when the folder is gone, or the reason it could not be removed.</summary>
        private static string TryDeleteDirectory(string path)
        {
            try
            {
                DeleteDirectory(path);
                return null;
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
        }

        private static string FullRoot(string path)
        {
            return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        }

        private static string RelativePath(string root, string file)
        {
            return Path.GetFullPath(file).Substring(FullRoot(root).Length).Replace(Path.DirectorySeparatorChar, '/');
        }

        private static string Sha256Hex(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = File.OpenRead(path))
            {
                byte[] hash = sha.ComputeHash(stream);
                StringBuilder text = new StringBuilder(hash.Length * 2);
                foreach (byte value in hash)
                {
                    text.Append(value.ToString("x2"));
                }
                return text.ToString();
            }
        }

        private static string SafeName(string value)
        {
            return Regex.Replace(value, "[^0-9A-Za-z._-]", "_");
        }

        private static void Report(Action<int, string> progressCallback, int percent, string text)
        {
            if (progressCallback != null)
            {
                progressCallback(percent, text);
            }
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
                Text = "Ready to install to " + InstallerEngine.GetInstallPath(),
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(220, 220, 230),
                Location = new Point(26, 105),
                Size = new Size(450, 22),
                AutoEllipsis = true
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
                    catch (Exception ex)
                    {
                        MessageBox.Show(this, "JOY Media was installed, but it could not be started: " + ex.Message,
                            "JOY Media Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
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
