using System;

namespace JoyMedia.Setup
{
    public static class UserPathEditor
    {
        // Returns the new user PATH value with the install folder present exactly once, or null when the
        // value already says that and needs no write. Compares after expanding variables and ignoring case and
        // a trailing backslash. It also repairs an entry that the v1.0.x install script glued onto the entry
        // before it ("C:\...\WindowsAppsC:\...\JOY Media"), which that script produced when the user PATH held
        // a single entry: the glued entry is split back into the two folders it was made from.
        public static string WithInstallDir(string path, string installPath)
        {
            string target = installPath.TrimEnd('\\');
            string[] parts = path.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            System.Collections.Generic.List<string> result = new System.Collections.Generic.List<string>();
            bool present = false;
            bool changed = false;
            foreach (string raw in parts)
            {
                string p = raw.Trim();
                if (p.Length == 0) { changed = true; continue; }
                string expanded = Environment.ExpandEnvironmentVariables(p).TrimEnd('\\');
                if (expanded.Equals(target, StringComparison.OrdinalIgnoreCase))
                {
                    if (present) { changed = true; continue; }
                    present = true;
                    result.Add(p);
                    continue;
                }
                if (expanded.Length > target.Length && expanded.EndsWith(target, StringComparison.OrdinalIgnoreCase))
                {
                    string head = expanded.Substring(0, expanded.Length - target.Length);
                    if (head.Length >= 3 && char.IsLetter(head[0]) && head[1] == ':' && head[2] == '\\')
                    {
                        result.Add(head);
                        if (!present) { result.Add(installPath); present = true; }
                        changed = true;
                        continue;
                    }
                }
                result.Add(p);
            }
            if (!present) { result.Add(installPath); changed = true; }
            return changed ? string.Join(";", result.ToArray()) : null;
        }
    }
}
