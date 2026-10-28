// Media Foundation probe, run outside Chromium (plan section 3.2, step 3). Without arguments it lists the hardware H.264
// video encoders that Media Foundation offers on this PC, one JSON line each, and exits. With `--encode <index>` it activates
// that encoder, sends one 640x360 NV12 frame, drains the encoder, and prints one JSON line (plan section 10d, G0 item 1).
// The encode runs only in the attended session G1, where the owner is at the PC. run-mf-encode.ps1 starts each encoder in its
// own process and records the exit code.
//
// No Windows SDK headers are installed on this PC, so the GUIDs, flags and vtable slots below are declared by hand from the
// public SDK. Run-time checks cover what the headers would have checked: every friendly name must read back as printable text,
// or the probe reports the entry as unreadable and exits with a failure code. The encode path is UNVERIFIED until G1.
//
// Compiled with the .NET Framework C# 5 compiler (csc.exe, v4.0.30319), which build-installer.ps1 already uses, so nothing new is
// installed. Build with tooling/diagnostics/mf-probe/build-mf-probe.ps1.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class MfProbe
{
    // MF_VERSION: SDK version 2 in the high word and API version 0x70 in the low word (Windows 7 and later).
    private const uint MfVersion = 0x00020070;
    private const uint MftEnumFlagHardware = 0x00000004;
    private const uint MftEnumFlagSortAndFilter = 0x00000040;
    private const int SOk = 0;
    private const int ExitEncodersListed = 0;
    private const int ExitEncoded = 0;
    private const int ExitNoEncoder = 2;
    private const int ExitFailure = 3;
    // Recalled, not checked: no Windows SDK on this PC, and a web search did not confirm it. It only labels the last-event text;
    // a failed GetEvent counts as no event yet either way.
    private const int MfENoEventsAvailable = unchecked((int)0xC00D3E80);
    private const int MfETransformNeedMoreInput = unchecked((int)0xC00D6D72);
    private const uint MftMessageCommandDrain = 0x00000001;
    private const uint MftMessageNotifyBeginStreaming = 0x10000000;
    private const uint MftMessageNotifyStartOfStream = 0x10000003;
    private const int MetransformNeedInput = 601;
    private const int MetransformHaveOutput = 602;
    private const int MetransformDrainComplete = 603;
    private const uint MfEventFlagNoWait = 0x00000001;
    private const int FrameWidth = 640;
    private const int FrameHeight = 360;
    private const int FrameRate = 30;
    private const uint InputFrameBytes = FrameWidth * FrameHeight * 3 / 2;
    private const uint OutputBufferBytes = 1024 * 1024;
    private const int EncodeWaitMilliseconds = 10000;
    // The encoder session stays open this long after the result line, so a sampler polling every 250 ms can see it.
    private const int DefaultHoldMilliseconds = 3000;

    private static readonly Guid MftCategoryVideoEncoder = new Guid("F79EAC7D-E545-4387-BDEE-D647D7BDE42A");
    // Confirmed on this PC: the activation objects carry this key (see ListKeys, which lists the keys they do carry).
    private static readonly Guid MftFriendlyNameAttribute = new Guid("314FFBAE-5B41-4C95-9C19-4E7D586FACE3");
    private static readonly Guid MfMediaTypeVideo = new Guid("73646976-0000-0010-8000-00AA00389B71");
    private static readonly Guid MfVideoFormatH264 = new Guid("34363248-0000-0010-8000-00AA00389B71");
    private static readonly Guid MfVideoFormatNv12 = new Guid("3231564E-0000-0010-8000-00AA00389B71");
    private static readonly Guid MfMtMajorType = new Guid("48EBA18E-F8C9-4687-BF11-0A74C9F96A8F");
    private static readonly Guid MfMtSubtype = new Guid("F7E34C9A-42E8-4714-B74B-CB29D72C35E5");
    private static readonly Guid MfMtFrameSize = new Guid("1652C33D-D6B2-4012-B834-72030849A37D");
    private static readonly Guid MfMtFrameRate = new Guid("C459A2E8-3D2C-4E44-B132-FEE5156C7BB0");
    // Recalled, not checked: no Windows SDK on this PC, and a web search did not confirm it. A wrong key leaves the aspect ratio
    // unset, which defaults to square pixels.
    private static readonly Guid MfMtPixelAspectRatio = new Guid("C6376A1E-8D0A-4027-BE45-6D9A0AD39BB6");
    private static readonly Guid MfMtInterlaceMode = new Guid("E2724BB8-E676-4806-B4B2-A8D6EFB44CCD");
    private static readonly Guid MfMtAvgBitrate = new Guid("20332624-FB0D-4D9E-BD0D-CBF6786C102E");
    private static readonly Guid MfTransformAsyncUnlock = new Guid("E5666D6B-3422-4EB6-A421-DA7DB1F8E207");
    private static readonly Guid IidMfTransform = new Guid("BF94C121-5B05-4E6F-8000-BA598961414D");

    [StructLayout(LayoutKind.Sequential)]
    private struct MftRegisterTypeInfo
    {
        public Guid MajorType;
        public Guid Subtype;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MftOutputDataBuffer
    {
        public uint StreamId;
        public IntPtr Sample;
        public uint Status;
        public IntPtr Events;
    }

    // IMFAttributes, declared slot by slot. Slot 0 to 2 are IUnknown. The names are the SDK's; the unnamed slots are never called.
    [ComImport, Guid("2CD2D921-C447-44A7-A13C-4ADABFC247E3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFAttributes
    {
        void Slot03();
        void Slot04();
        void Slot05();
        void Slot06();
        // Slot 7: GetUINT32(REFGUID guidKey, UINT32 *punValue).
        [PreserveSig]
        int GetUINT32(ref Guid key, out uint value);
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
        // Slot 21: SetUINT32. Slot 22: SetUINT64.
        [PreserveSig]
        int SetUINT32(ref Guid key, uint value);
        [PreserveSig]
        int SetUINT64(ref Guid key, ulong value);
        void Slot23();
        // Slot 24: SetGUID(REFGUID guidKey, REFGUID guidValue).
        [PreserveSig]
        int SetGUID(ref Guid key, ref Guid value);
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
        void Slot32();
    }

    // IMFActivate extends IMFAttributes. Slot 33: ActivateObject(REFIID riid, void **ppv).
    [ComImport, Guid("7FEE9E9A-4A89-47A6-899C-B6A53A70FB67"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFActivate : IMFAttributes
    {
        [PreserveSig]
        int ActivateObject(ref Guid riid, out IntPtr obj);

        [PreserveSig]
        int ShutdownObject();
        void DetachObject();
    }

    [ComImport, Guid("44AE0FA8-EA31-4109-8D2E-4CAE4997C555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFMediaType : IMFAttributes
    {
    }

    [ComImport, Guid("DF598932-F10C-4E39-BBA2-C308F101DAA3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFMediaEvent : IMFAttributes
    {
        // Slot 33: GetType(MediaEventType *pmet).
        [PreserveSig]
        int GetType(out uint eventType);
    }

    [ComImport, Guid("2CD0BD52-BCD5-4B89-B62C-EADC0C031E7D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFMediaEventGenerator
    {
        // Slot 3: GetEvent(DWORD dwFlags, IMFMediaEvent **ppEvent).
        [PreserveSig]
        int GetEvent(uint flags, out IMFMediaEvent mediaEvent);
    }

    [ComImport, Guid("045FA593-8799-42B8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFMediaBuffer
    {
        // Slot 3: Lock(BYTE **ppbBuffer, DWORD *pcbMaxLength, DWORD *pcbCurrentLength).
        [PreserveSig]
        int Lock(out IntPtr buffer, out uint maxLength, out uint currentLength);

        [PreserveSig]
        int Unlock();

        [PreserveSig]
        int GetCurrentLength(out uint currentLength);

        [PreserveSig]
        int SetCurrentLength(uint currentLength);

        [PreserveSig]
        int GetMaxLength(out uint maxLength);
    }

    // IMFSample extends IMFAttributes. Slots 33 to 46 follow the SDK order.
    [ComImport, Guid("C40A00F2-B93A-4D80-AE8C-5A1C4EC9C3A6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFSample : IMFAttributes
    {
        void Slot33();
        void Slot34();
        void Slot35();
        // Slot 36: SetSampleTime(LONGLONG hnsSampleTime).
        [PreserveSig]
        int SetSampleTime(long time);

        void Slot37();
        // Slot 38: SetSampleDuration(LONGLONG hnsSampleDuration).
        [PreserveSig]
        int SetSampleDuration(long duration);

        void Slot39();
        void Slot40();
        void Slot41();
        // Slot 42: AddBuffer(IMFMediaBuffer *pBuffer).
        [PreserveSig]
        int AddBuffer(IMFMediaBuffer buffer);

        void Slot43();
        void Slot44();
        // Slot 45: GetTotalLength(DWORD *pcbTotalLength).
        [PreserveSig]
        int GetTotalLength(out uint length);

        void Slot46();
    }

    // IMFTransform, declared from IUnknown. Slots 15 and 16 set the types, 19 and 20 read the status, 23 to 25 move the data.
    [ComImport, Guid("BF94C121-5B05-4E6F-8000-BA598961414D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMFTransform
    {
        void Slot03();
        void Slot04();
        void Slot05();
        void Slot06();
        void Slot07();
        // Slot 8: GetAttributes(IMFAttributes **pAttributes).
        [PreserveSig]
        int GetAttributes(out IMFAttributes attributes);

        void Slot09();
        void Slot10();
        void Slot11();
        void Slot12();
        void Slot13();
        void Slot14();
        // Slot 15: SetInputType(DWORD dwInputStreamID, IMFMediaType *pType, DWORD dwFlags).
        [PreserveSig]
        int SetInputType(uint streamId, IMFMediaType type, uint flags);

        // Slot 16: SetOutputType(DWORD dwOutputStreamID, IMFMediaType *pType, DWORD dwFlags).
        [PreserveSig]
        int SetOutputType(uint streamId, IMFMediaType type, uint flags);

        void Slot17();
        void Slot18();
        // Slot 19: GetInputStatus(DWORD dwInputStreamID, DWORD *pdwFlags).
        [PreserveSig]
        int GetInputStatus(uint streamId, out uint flags);

        void Slot20();
        void Slot21();
        void Slot22();
        // Slot 23: ProcessMessage(MFT_MESSAGE_TYPE eMessage, ULONG_PTR ulParam).
        [PreserveSig]
        int ProcessMessage(uint message, IntPtr param);

        // Slot 24: ProcessInput(DWORD dwInputStreamID, IMFSample *pSample, DWORD dwFlags).
        [PreserveSig]
        int ProcessInput(uint streamId, IMFSample sample, uint flags);

        // Slot 25: ProcessOutput(DWORD dwFlags, DWORD cOutputBufferCount, MFT_OUTPUT_DATA_BUFFER *pOutputSamples, DWORD *pdwStatus).
        [PreserveSig]
        int ProcessOutput(uint flags, uint count, ref MftOutputDataBuffer samples, out uint status);
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

    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFCreateMediaType(out IntPtr mediaType);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFCreateSample(out IntPtr sample);

    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFCreateMemoryBuffer(uint maxLength, out IntPtr buffer);

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern void CoTaskMemFree(IntPtr memory);

    private static int Main(string[] args)
    {
        // --encode <index> [--hold-ms <milliseconds>]. The hold keeps the encoder session open after the result line.
        if ((args.Length == 2 || args.Length == 4) && args[0] == "--encode")
        {
            int index;
            int holdMilliseconds = DefaultHoldMilliseconds;
            bool holdOk = args.Length == 2 || (args[2] == "--hold-ms" && int.TryParse(args[3], out holdMilliseconds) && holdMilliseconds >= 0);
            if (holdOk && int.TryParse(args[1], out index) && index >= 0) return EncodeOne(index, holdMilliseconds);
            Emit("{\"event\":\"usage\",\"error\":\"index\"}");
            return ExitFailure;
        }
        return ListEncoders();
    }

    private static int ListEncoders()
    {
        int hr = MFStartup(MfVersion, 0);
        if (hr != SOk)
        {
            Emit("{\"event\":\"mfstartup\",\"hr\":" + hr + "}");
            return ExitFailure;
        }

        IntPtr activates;
        uint count;
        hr = EnumerateH264Encoders(out activates, out count);
        if (hr != SOk)
        {
            Emit("{\"event\":\"mftenumex\",\"hr\":" + hr + "}");
            MFShutdown();
            return ExitFailure;
        }

        int failures = 0;
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

    // Hardware H.264 video encoders, in the order `--list` prints them. The caller frees the array and releases each entry.
    private static int EnumerateH264Encoders(out IntPtr activates, out uint count)
    {
        IntPtr outputType = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(MftRegisterTypeInfo)));
        activates = IntPtr.Zero;
        count = 0;
        int hr;
        try
        {
            Marshal.StructureToPtr(
                new MftRegisterTypeInfo { MajorType = MfMediaTypeVideo, Subtype = MfVideoFormatH264 },
                outputType,
                false);
            Guid category = MftCategoryVideoEncoder;
            hr = MFTEnumEx(category, MftEnumFlagHardware | MftEnumFlagSortAndFilter, IntPtr.Zero, outputType, out activates, out count);
        }
        finally
        {
            Marshal.FreeHGlobal(outputType);
        }
        return hr;
    }

    // Activates encoder `index`, sends one NV12 frame, drains, and prints the one result line. Exit 0 when output bytes were
    // produced, 2 when there is no encoder at that index, and 3 for any failure. Each step's HRESULT is printed, so a failure
    // shows the step that failed.
    private static int EncodeOne(int index, int holdMilliseconds)
    {
        int? activateHr = null;
        int? setTypeHr = null;
        int? processHr = null;
        long outputBytes = 0;
        string name = null;
        string stage = "start";
        int exit = ExitFailure;

        IntPtr activates = IntPtr.Zero;
        IntPtr activateRaw = IntPtr.Zero;
        bool started = false;
        try
        {
            int hr = MFStartup(MfVersion, 0);
            if (hr != SOk)
            {
                Emit(EncodeLine(index, name, activateHr, setTypeHr, processHr, outputBytes, "mfstartup hr=0x" + ((uint)hr).ToString("X8")));
                return ExitFailure;
            }
            started = true;

            uint count;
            hr = EnumerateH264Encoders(out activates, out count);
            if (hr != SOk)
            {
                Emit(EncodeLine(index, name, activateHr, setTypeHr, processHr, outputBytes, "mftenumex hr=0x" + ((uint)hr).ToString("X8")));
                return ExitFailure;
            }
            if (index >= count)
            {
                Emit(EncodeLine(index, name, activateHr, setTypeHr, processHr, outputBytes, "no-encoder"));
                return ExitNoEncoder;
            }

            activateRaw = Marshal.ReadIntPtr(activates, index * IntPtr.Size);
            name = ReadFriendlyName(activateRaw);
            IMFActivate activate = (IMFActivate)Marshal.GetObjectForIUnknown(activateRaw);
            stage = "activate";
            Guid transformIid = IidMfTransform;
            IntPtr transformRaw;
            hr = activate.ActivateObject(ref transformIid, out transformRaw);
            activateHr = hr;
            Check(hr, stage);
            IMFTransform transform = (IMFTransform)Marshal.GetObjectForIUnknown(transformRaw);
            Marshal.Release(transformRaw);

            // An asynchronous encoder reports its progress through events. It must be unlocked before use.
            IMFMediaEventGenerator events = transform as IMFMediaEventGenerator;
            bool isAsync = events != null;
            if (isAsync)
            {
                stage = "unlock";
                IMFAttributes attributes;
                Check(transform.GetAttributes(out attributes), stage);
                Guid unlockKey = MfTransformAsyncUnlock;
                Check(attributes.SetUINT32(ref unlockKey, 1), stage);
                Marshal.ReleaseComObject(attributes);
            }

            stage = "set-output-type";
            IMFMediaType outputType = NewVideoType(MfVideoFormatH264, true);
            setTypeHr = transform.SetOutputType(0, outputType, 0);
            Check(setTypeHr.Value, stage);
            stage = "set-input-type";
            IMFMediaType inputType = NewVideoType(MfVideoFormatNv12, false);
            setTypeHr = transform.SetInputType(0, inputType, 0);
            Check(setTypeHr.Value, stage);

            stage = "begin-streaming";
            Check(transform.ProcessMessage(MftMessageNotifyBeginStreaming, IntPtr.Zero), stage);
            Check(transform.ProcessMessage(MftMessageNotifyStartOfStream, IntPtr.Zero), stage);

            stage = "process-input";
            if (isAsync) WaitForEvent(events, MetransformNeedInput, stage);
            IMFSample inputSample = NewInputSample();
            processHr = transform.ProcessInput(0, inputSample, 0);
            Check(processHr.Value, stage);

            stage = "drain";
            Check(transform.ProcessMessage(MftMessageCommandDrain, IntPtr.Zero), stage);

            stage = "process-output";
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(EncodeWaitMilliseconds);
            bool drained = false;
            while (!drained && DateTime.UtcNow < deadline)
            {
                if (isAsync)
                {
                    int eventType = NextEventType(events);
                    if (eventType == -1)
                    {
                        Thread.Sleep(10);
                        continue;
                    }
                    if (eventType == MetransformDrainComplete)
                    {
                        drained = true;
                        continue;
                    }
                    if (eventType != MetransformHaveOutput) continue;
                }

                // The probe supplies its own output sample. An encoder that supplies samples itself is reported as a failed
                // ProcessOutput; that case is not handled here (UNVERIFIED until G1).
                IMFSample outputSample = NewOutputSample();
                IntPtr samplePointer = Marshal.GetComInterfaceForObject(outputSample, typeof(IMFSample));
                MftOutputDataBuffer buffer = new MftOutputDataBuffer { Sample = samplePointer };
                uint status;
                int outHr = transform.ProcessOutput(0, 1, ref buffer, out status);
                Marshal.Release(samplePointer);
                if (outHr == MfETransformNeedMoreInput)
                {
                    if (!isAsync) drained = true;
                    continue;
                }
                Check(outHr, stage);
                uint length;
                Check(outputSample.GetTotalLength(out length), stage);
                outputBytes += length;
                if (!isAsync) drained = true;
            }
            exit = outputBytes > 0 ? ExitEncoded : ExitFailure;
            Emit(EncodeLine(index, name, activateHr, setTypeHr, processHr, outputBytes, exit == ExitFailure ? "no-output last-event-hr=0x" + ((uint)lastEventHr).ToString("X8") : "ok"));
            // Keep the encoder session open for the hold. ShutdownObject then ends the session, which would otherwise last until
            // the process exits. The objects are released after that.
            if (holdMilliseconds > 0) Thread.Sleep(holdMilliseconds);
            // The result line is already out. Its HRESULT is ignored, so a shutdown failure cannot change the encode result.
            activate.ShutdownObject();
            Marshal.ReleaseComObject(activate);
            Marshal.ReleaseComObject(transform);
        }
        catch (EncodeStepException failure)
        {
            Emit(EncodeLine(index, name, activateHr, setTypeHr, processHr, outputBytes, failure.Stage + " hr=0x" + ((uint)failure.Hr).ToString("X8")));
            exit = ExitFailure;
        }
        catch (Exception failure)
        {
            // Any other failure, including one before the first step, still prints one result line, with its HRESULT.
            string detail = stage + " " + failure.GetType().Name + " hr=0x" + ((uint)failure.HResult).ToString("X8");
            Emit(EncodeLine(index, name, activateHr, setTypeHr, processHr, outputBytes, detail));
            exit = ExitFailure;
        }
        finally
        {
            if (activateRaw != IntPtr.Zero) Marshal.Release(activateRaw);
            if (activates != IntPtr.Zero) CoTaskMemFree(activates);
            if (started) MFShutdown();
        }
        return exit;
    }

    private sealed class EncodeStepException : Exception
    {
        public readonly string Stage;
        public readonly int Hr;

        public EncodeStepException(string stage, int hr) : base(stage)
        {
            Stage = stage;
            Hr = hr;
        }
    }

    private static void Check(int hr, string stage)
    {
        if (hr != SOk) throw new EncodeStepException(stage, hr);
    }

    // The NV12 frame, 640x360, filled with black (Y 16, UV 128), stamped at time 0.
    private static IMFSample NewInputSample()
    {
        IMFSample sample = NewSample();
        IntPtr bufferRaw;
        Check(MFCreateMemoryBuffer(InputFrameBytes, out bufferRaw), "create-buffer");
        IMFMediaBuffer buffer = (IMFMediaBuffer)Marshal.GetObjectForIUnknown(bufferRaw);
        Marshal.Release(bufferRaw);
        IntPtr data;
        uint maxLength;
        uint currentLength;
        Check(buffer.Lock(out data, out maxLength, out currentLength), "lock");
        int lumaBytes = FrameWidth * FrameHeight;
        for (int offset = 0; offset < (int)InputFrameBytes; offset++)
        {
            Marshal.WriteByte(data, offset, offset < lumaBytes ? (byte)16 : (byte)128);
        }
        Check(buffer.Unlock(), "unlock-buffer");
        Check(buffer.SetCurrentLength(InputFrameBytes), "set-length");
        Check(sample.AddBuffer(buffer), "add-buffer");
        Check(sample.SetSampleTime(0), "set-time");
        Check(sample.SetSampleDuration(10000000L / FrameRate), "set-duration");
        return sample;
    }

    private static IMFSample NewOutputSample()
    {
        IMFSample sample = NewSample();
        IntPtr bufferRaw;
        Check(MFCreateMemoryBuffer(OutputBufferBytes, out bufferRaw), "create-output-buffer");
        IMFMediaBuffer buffer = (IMFMediaBuffer)Marshal.GetObjectForIUnknown(bufferRaw);
        Marshal.Release(bufferRaw);
        Check(sample.AddBuffer(buffer), "add-output-buffer");
        return sample;
    }

    private static IMFSample NewSample()
    {
        IntPtr raw;
        Check(MFCreateSample(out raw), "create-sample");
        IMFSample sample = (IMFSample)Marshal.GetObjectForIUnknown(raw);
        Marshal.Release(raw);
        return sample;
    }

    // A video media type. The frame size and rate are packed as two 32-bit halves, as the SDK defines them.
    private static IMFMediaType NewVideoType(Guid subtype, bool compressed)
    {
        IntPtr raw;
        Check(MFCreateMediaType(out raw), "create-type");
        IMFMediaType type = (IMFMediaType)Marshal.GetObjectForIUnknown(raw);
        Marshal.Release(raw);
        Guid majorKey = MfMtMajorType;
        Guid majorValue = MfMediaTypeVideo;
        Check(type.SetGUID(ref majorKey, ref majorValue), "type-major");
        Guid subtypeKey = MfMtSubtype;
        Guid subtypeValue = subtype;
        Check(type.SetGUID(ref subtypeKey, ref subtypeValue), "type-subtype");
        Guid sizeKey = MfMtFrameSize;
        Check(type.SetUINT64(ref sizeKey, ((ulong)FrameWidth << 32) | (uint)FrameHeight), "type-size");
        Guid rateKey = MfMtFrameRate;
        Check(type.SetUINT64(ref rateKey, ((ulong)FrameRate << 32) | 1UL), "type-rate");
        Guid aspectKey = MfMtPixelAspectRatio;
        Check(type.SetUINT64(ref aspectKey, (1UL << 32) | 1UL), "type-aspect");
        Guid interlaceKey = MfMtInterlaceMode;
        Check(type.SetUINT32(ref interlaceKey, 2), "type-interlace");
        if (compressed)
        {
            Guid bitrateKey = MfMtAvgBitrate;
            Check(type.SetUINT32(ref bitrateKey, 2000000), "type-bitrate");
        }
        return type;
    }

    // Blocks, polling, until the encoder reports the wanted event, or the wait runs out.
    private static void WaitForEvent(IMFMediaEventGenerator events, int wanted, string stage)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(EncodeWaitMilliseconds);
        while (DateTime.UtcNow < deadline)
        {
            int eventType = NextEventType(events);
            if (eventType == wanted) return;
            if (eventType == -1) Thread.Sleep(10);
        }
        throw new EncodeStepException(stage, lastEventHr != 0 ? lastEventHr : unchecked((int)0x80004004));
    }

    // The last GetEvent HRESULT that was not an event. It is diagnostic only, and the wait reports it if it never clears.
    private static int lastEventHr;

    // The next event's type, or -1 when none is waiting. Any other failed GetEvent also means "none yet", and its HRESULT is kept.
    private static int NextEventType(IMFMediaEventGenerator events)
    {
        IMFMediaEvent mediaEvent;
        int hr = events.GetEvent(MfEventFlagNoWait, out mediaEvent);
        if (hr == MfENoEventsAvailable) return -1;
        if (hr != SOk)
        {
            lastEventHr = hr;
            return -1;
        }
        uint eventType;
        Check(mediaEvent.GetType(out eventType), "get-event-type");
        return (int)eventType;
    }

    private static string EncodeLine(int index, string name, int? activateHr, int? setTypeHr, int? processHr, long outputBytes, string detail)
    {
        return "{\"index\":" + index
            + ",\"friendlyName\":" + (name == null ? "null" : "\"" + Escape(name) + "\"")
            + ",\"activateHr\":" + Hex(activateHr)
            + ",\"setTypeHr\":" + Hex(setTypeHr)
            + ",\"processHr\":" + Hex(processHr)
            + ",\"outputBytes\":" + outputBytes
            + ",\"detail\":\"" + Escape(detail) + "\"}";
    }

    private static string Hex(int? value)
    {
        return value.HasValue ? "\"0x" + ((uint)value.Value).ToString("X8") + "\"" : "null";
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
