using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

// Chrome requires an executable on Windows. This tiny host passes binary stdio
// through to the installed Node companion without interpreting browser messages.
public static class TandixNativeProxy
{
    private static void CopyAndFlush(Stream source, Stream destination)
    {
        byte[] buffer = new byte[8192];
        int length;
        while ((length = source.Read(buffer, 0, buffer.Length)) > 0)
        {
            destination.Write(buffer, 0, length);
            destination.Flush();
        }
    }

    public static int Main()
    {
        try
        {
            string settings = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.txt");
            string[] paths = File.ReadAllLines(settings);
            if (paths.Length != 2 || !File.Exists(paths[0]) || !File.Exists(paths[1])) return 2;

            var info = new ProcessStartInfo();
            info.FileName = paths[0];
            info.Arguments = "\"" + paths[1].Replace("\"", "\\\"") + "\"";
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (var child = Process.Start(info))
            {
                if (child == null) return 3;
                Task input = Task.Run(() => {
                    try { CopyAndFlush(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                    finally { child.StandardInput.Close(); }
                });
                Task output = Task.Run(() => CopyAndFlush(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
                Task error = Task.Run(() => CopyAndFlush(child.StandardError.BaseStream, Console.OpenStandardError()));
                child.WaitForExit();
                Task.WaitAll(output, error);
                return child.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("Tandix native companion failed: " + e.Message);
            return 1;
        }
    }
}
