// Media Foundation probe, run outside Chromium (plan section 3.2, step 3). It lists the hardware H.264 video encoders that
// Media Foundation offers on this PC, one JSON line each, and exits. It does not activate or encode anything yet. The one-frame
// encode belongs to the attended session G1, where the owner is at the PC.
//
// No Windows SDK headers are installed on this PC, so the GUIDs, flags and vtable slots below are declared by hand from the
// public SDK. Run-time checks cover what the headers would have checked: every friendly name must read back as printable text,
// or the probe reports the entry as unreadable and exits with a failure code.
//
// Compiled with the .NET Framework C# 5 compiler (csc.exe, v4.0.30319), which build-installer.ps1 already uses, so nothing new is
// installed. Build with tooling/diagnostics/mf-probe/build-mf-probe.ps1.
using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class MfProbe
{
    // MF_VERSION: SDK version 2 in the high word and API version 0x70 in the low word (Windows 7 and later).
    private const uint MfVersion = 0x00020070;
    private const uint MftEnumFlagHardware = 0x00000004;
    private const uint MftEnumFlagSortAndFilter = 0x00000040;
    private const int SOk = 0;
    private const int ExitEncodersListed = 0;
    private const int ExitNoEncoder = 2;
    private const int ExitFailure = 3;

    private static readonly Guid MftCategoryVideoEncoder = new Guid("F79EAC7D-E545-4387-BDEE-D647D7BDE42A");
    // Confirmed on this PC: the activation objects carry this key (see ListKeys, which lists the keys they do carry).
    private static readonly Guid MftFriendlyNameAttribute = new Guid("314FFBAE-5B41-4C95-9C19-4E7D586FACE3");
    private static readonly Guid MfMediaTypeVideo = new Guid("73646976-0000-0010-8000-00AA00389B71");
    private static readonly Guid MfVideoFormatH264 = new Guid("34363248-0000-0010-8000-00AA00389B71");

    [StructLayout(LayoutKind.Sequential)]
    private struct MftRegisterTypeInfo
    {
        public Guid MajorType;
        public Guid Subtype;
    }

    // IMFAttributes, declared up to the one method this probe calls. Slots 3 to 12 are the SDK methods before it, in the SDK's order.
    [ComImport, Guid("2CD2D921-C447-44A7-A13C-4ADABFC247E3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFAttributes
    {
        void Slot03();
        void Slot04();
        void Slot05();
        void Slot06();
        void Slot07();
        void Slot08();
        void Slot09();
        void Slot10();
        void Slot11();
        void Slot12();

        // Slot 13: GetAllocatedString(REFGUID guidKey, LPWSTR *ppwszValue, UINT32 *pcchLength).
        [PreserveSig]
        int GetAllocatedString(ref Guid key, out IntPtr value, out uint length);

        void Slot14();
        void Slot15();
        void Slot16();
        void Slot17();
        void Slot18();
        void Slot19();
        void Slot20();
        void Slot21();
        void Slot22();
        void Slot23();
        void Slot24();
        void Slot25();
        void Slot26();
        void Slot27();
        void Slot28();
        void Slot29();

        // Slot 30: GetCount(UINT32 *pcItems). Slot 31: GetItemByIndex(UINT32 index, GUID *pguidKey, PROPVARIANT *pValue).
        [PreserveSig]
        int GetCount(out uint count);

        [PreserveSig]
        int GetItemByIndex(uint index, out Guid key, IntPtr value);
    }

    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFStartup(uint version, uint flags);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFShutdown();

    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFTEnumEx(
        Guid category,
        uint flags,
        IntPtr inputType,
        IntPtr outputType,
        out IntPtr activates,
        out uint count);

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern void CoTaskMemFree(IntPtr memory);

    private static int Main()
    {
        int hr = MFStartup(MfVersion, 0);
        if (hr != SOk)
        {
            Emit("{\"event\":\"mfstartup\",\"hr\":" + hr + "}");
            return ExitFailure;
        }

        IntPtr outputType = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(MftRegisterTypeInfo)));
        IntPtr activates = IntPtr.Zero;
        uint count = 0;
        int failures = 0;
        try
        {
            Marshal.StructureToPtr(
                new MftRegisterTypeInfo { MajorType = MfMediaTypeVideo, Subtype = MfVideoFormatH264 },
                outputType,
                false);
            hr = MFTEnumEx(
                MftCategoryVideoEncoder,
                MftEnumFlagHardware | MftEnumFlagSortAndFilter,
                IntPtr.Zero,
                outputType,
                out activates,
                out count);
        }
        finally
        {
            Marshal.FreeHGlobal(outputType);
        }
        if (hr != SOk)
        {
            Emit("{\"event\":\"mftenumex\",\"hr\":" + hr + "}");
            MFShutdown();
            return ExitFailure;
        }

        for (uint index = 0; index < count; index++)
        {
            IntPtr raw = Marshal.ReadIntPtr(activates, (int)index * IntPtr.Size);
            string name = ReadFriendlyName(raw);
            if (name == null)
            {
                failures++;
                Emit("{\"event\":\"encoder\",\"index\":" + index + ",\"name\":null,\"error\":\"unreadable\",\"stage\":\"" + lastFailure + "\"}");
            }
            else
            {
                Emit("{\"event\":\"encoder\",\"index\":" + index + ",\"name\":\"" + Escape(name) + "\"}");
            }
            Marshal.Release(raw);
        }
        if (activates != IntPtr.Zero) CoTaskMemFree(activates);
        MFShutdown();

        Emit("{\"event\":\"done\",\"encoders\":" + count + ",\"unreadable\":" + failures + "}");
        if (failures > 0) return ExitFailure;
        return count > 0 ? ExitEncodersListed : ExitNoEncoder;
    }

    // Why the last ReadFriendlyName call returned null: "cast" (no IMFAttributes interface), "call hr=..." (the call failed), or "text".
    private static string lastFailure;

    // Reads the friendly name of one activation object through IMFAttributes, which IMFActivate derives from. Returns null when
    // the object cannot be read or the text is not printable, and records why in lastFailure.
    private static string ReadFriendlyName(IntPtr raw)
    {
        lastFailure = null;
        object wrapper = Marshal.GetObjectForIUnknown(raw);
        IMFAttributes attributes = wrapper as IMFAttributes;
        if (attributes == null)
        {
            lastFailure = "cast";
            return null;
        }

        Guid key = MftFriendlyNameAttribute;
        IntPtr text;
        uint length;
        int hr = attributes.GetAllocatedString(ref key, out text, out length);
        if (hr != SOk)
        {
            lastFailure = "call hr=" + hr;
            ListKeys(attributes);
            Marshal.ReleaseComObject(attributes);
            return null;
        }
        string name = text == IntPtr.Zero ? null : Marshal.PtrToStringUni(text);
        if (text != IntPtr.Zero) CoTaskMemFree(text);
        Marshal.ReleaseComObject(attributes);
        if (name == null || name.Length == 0 || !IsPrintable(name))
        {
            lastFailure = "text";
            return null;
        }
        return name;
    }

    // Diagnostic only: the attribute keys an activation object carries, so a missing friendly-name key shows what is there.
    private static void ListKeys(IMFAttributes attributes)
    {
        uint count;
        if (attributes.GetCount(out count) != SOk)
        {
            Emit("{\"event\":\"attribute-keys\",\"error\":\"count\"}");
            return;
        }
        StringBuilder keys = new StringBuilder();
        IntPtr value = Marshal.AllocHGlobal(32);
        try
        {
            for (uint i = 0; i < count; i++)
            {
                Guid key;
                if (attributes.GetItemByIndex(i, out key, value) != SOk) continue;
                if (keys.Length > 0) keys.Append(',');
                keys.Append('"').Append(key.ToString("B")).Append('"');
            }
        }
        finally
        {
            Marshal.FreeHGlobal(value);
        }
        Emit("{\"event\":\"attribute-keys\",\"count\":" + count + ",\"keys\":[" + keys + "]}");
    }

    private static bool IsPrintable(string text)
    {
        foreach (char c in text)
        {
            if (c < 0x20 || c > 0x7e) return false;
        }
        return true;
    }

    // JSON string escaping for the characters a name can carry. The output stays ASCII.
    private static string Escape(string text)
    {
        StringBuilder builder = new StringBuilder();
        foreach (char c in text)
        {
            if (c == '"' || c == '\\') builder.Append('\\').Append(c);
            else if (c < 0x20 || c > 0x7e) builder.Append("\\u").Append(((int)c).ToString("x4"));
            else builder.Append(c);
        }
        return builder.ToString();
    }

    private static void Emit(string line)
    {
        Console.Out.WriteLine(line);
    }
}
