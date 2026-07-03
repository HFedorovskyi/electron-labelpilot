using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace RawPrint
{
    public class RawPrinterHelper
    {
        // Structure and API declarions:
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
        public class DOCINFOA
        {
            [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
            [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
            [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
        }
        [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);

        [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        public static extern bool ClosePrinter(IntPtr hPrinter);

        [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

        [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        public static extern bool EndDocPrinter(IntPtr hPrinter);

        [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        public static extern bool StartPagePrinter(IntPtr hPrinter);

        [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        public static extern bool EndPagePrinter(IntPtr hPrinter);

        [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
        public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

        // SendBytesToPrinter()
        // When the function is given a printer name and an unmanaged array
        // of bytes, the function sends those bytes to the print queue.
        // Returns true on success, false on failure.
        public static bool SendBytesToPrinter(string szPrinterName, IntPtr pBytes, Int32 dwCount)
        {
            Int32 dwError = 0, dwWritten = 0;
            IntPtr hPrinter = new IntPtr(0);
            DOCINFOA di = new DOCINFOA();
            bool bSuccess = false; // Assume failure unless you specifically succeed.

            di.pDocName = "LabelPilot Document";
            di.pDataType = "RAW";

            // Open the printer.
            if (OpenPrinter(szPrinterName.Normalize(), out hPrinter, IntPtr.Zero))
            {
                // Start a document.
                if (StartDocPrinter(hPrinter, 1, di))
                {
                    // Start a page.
                    if (StartPagePrinter(hPrinter))
                    {
                        // Write your bytes.
                        bSuccess = WritePrinter(hPrinter, pBytes, dwCount, out dwWritten);
                        EndPagePrinter(hPrinter);
                    }
                    EndDocPrinter(hPrinter);
                }
                ClosePrinter(hPrinter);
            }
            // If you did not succeed, GetLastError may give more information
            // about why.
            if (bSuccess == false)
            {
                dwError = Marshal.GetLastWin32Error();
                Console.Error.WriteLine("Error code: " + dwError);
            }
            return bSuccess;
        }

        public static bool SendFileToPrinter(string szPrinterName, string szFileName)
        {
            // Open the file.
            FileStream fs = new FileStream(szFileName, FileMode.Open);
            // Create a BinaryReader on the file.
            BinaryReader br = new BinaryReader(fs);
            // Dim an array of bytes big enough to hold the file's contents.
            Byte[] bytes = new Byte[fs.Length];
            bool bSuccess = false;
            // Your unmanaged pointer.
            IntPtr pUnmanagedBytes = new IntPtr(0);
            int nLength;

            nLength = Convert.ToInt32(fs.Length);
            // Read the contents of the file into the array.
            bytes = br.ReadBytes(nLength);
            // Allocate some unmanaged memory for those bytes.
            pUnmanagedBytes = Marshal.AllocCoTaskMem(nLength);
            // Copy the managed byte array into the unmanaged array.
            Marshal.Copy(bytes, 0, pUnmanagedBytes, nLength);
            // Send the unmanaged bytes to the printer.
            bSuccess = SendBytesToPrinter(szPrinterName, pUnmanagedBytes, nLength);
            // Free the unmanaged memory that you allocated earlier.
            Marshal.FreeCoTaskMem(pUnmanagedBytes);
            fs.Close();
            return bSuccess;
        }
    }
    
    class Program
    {
        // ── Resident server mode ─────────────────────────────────────────
        // RawPrint.exe --server
        // Protocol (stdin → stdout, one request at a time):
        //   "PRINT\t<printerName>\t<byteCount>\n" followed by exactly byteCount raw bytes
        //   → "OK\n" or "ERR <message>\n"
        // Exits when stdin closes. Eliminates the per-label process spawn (CLR init +
        // Defender scan, 100-400ms on weak terminals) and the temp-file roundtrip.
        static int ServerLoop()
        {
            Stream stdin = Console.OpenStandardInput();
            StreamWriter writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            writer.AutoFlush = true;

            while (true)
            {
                string line = ReadLineRaw(stdin);
                if (line == null) return 0; // stdin closed → parent exited
                line = line.Trim();
                if (line.Length == 0) continue;

                string[] parts = line.Split('\t');
                int count;
                if (parts.Length != 3 || parts[0] != "PRINT" ||
                    !int.TryParse(parts[2], out count) || count < 0 || count > 64 * 1024 * 1024)
                {
                    writer.WriteLine("ERR bad-command");
                    continue;
                }

                byte[] data = new byte[count];
                int off = 0;
                while (off < count)
                {
                    int n = stdin.Read(data, off, count - off);
                    if (n <= 0) return 1; // stream broke mid-payload
                    off += n;
                }

                bool ok = false;
                string err = "";
                try
                {
                    IntPtr p = Marshal.AllocCoTaskMem(count);
                    try
                    {
                        Marshal.Copy(data, 0, p, count);
                        ok = RawPrinterHelper.SendBytesToPrinter(parts[1], p, count);
                    }
                    finally { Marshal.FreeCoTaskMem(p); }
                    if (!ok) err = "winspool error";
                }
                catch (Exception ex)
                {
                    ok = false;
                    err = ex.Message.Replace('\r', ' ').Replace('\n', ' ');
                }
                writer.WriteLine(ok ? "OK" : ("ERR " + err));
            }
        }

        // Console.In buffers ahead and would swallow payload bytes — read the raw stream.
        static string ReadLineRaw(Stream s)
        {
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                int b = s.ReadByte();
                if (b < 0) return sb.Length > 0 ? sb.ToString() : null;
                if (b == '\n') return sb.ToString();
                if (b != '\r') sb.Append((char)b);
            }
        }

        static void Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--server")
            {
                Environment.Exit(ServerLoop());
            }

            if (args.Length < 2)
            {
                Console.WriteLine("Usage: RawPrint.exe \"Printer Name\" \"Path to File\"  |  RawPrint.exe --server");
                return;
            }
            
            string printerName = args[0];
            string filePath = args[1];
            
            if (!File.Exists(filePath)) 
            {
                Console.Error.WriteLine("File not found: " + filePath);
                Environment.Exit(1);
            }
            
            bool success = RawPrinterHelper.SendFileToPrinter(printerName, filePath);
            
            if (success) 
            {
                Console.WriteLine("Successfully sent to printer.");
                Environment.Exit(0);
            }
            else 
            {
                Console.Error.WriteLine("Failed to send to printer.");
                Environment.Exit(1);
            }
        }
    }
}
