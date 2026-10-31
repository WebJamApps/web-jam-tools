// src/health-tracker/open_chrome.ts
// Opens the generated SVG in Google Chrome on the laptop screen detached (web-jam-tools#1660).

import * as path from "@std/path";

export interface DisplayEnv {
  display: string;
  xauthority?: string;
}

/**
 * Resolves the desktop display environment, checking process env or systemctl show-environment.
 */
export async function resolveDisplayEnv(): Promise<DisplayEnv> {
  const currentDisplay = Deno.env.get("DISPLAY");
  const currentXauth = Deno.env.get("XAUTHORITY");

  if (currentDisplay && currentDisplay.trim() !== "") {
    return {
      display: currentDisplay.trim(),
      xauthority: currentXauth ? currentXauth.trim() : undefined,
    };
  }

  try {
    const cmd = new Deno.Command("systemctl", {
      args: ["--user", "show-environment"],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    if (output.success) {
      const text = new TextDecoder().decode(output.stdout);
      let foundDisplay: string | undefined;
      let foundXauth: string | undefined;

      for (const line of text.split("\n")) {
        if (line.startsWith("DISPLAY=")) {
          foundDisplay = line.slice("DISPLAY=".length).trim();
        } else if (line.startsWith("XAUTHORITY=")) {
          foundXauth = line.slice("XAUTHORITY=".length).trim();
        }
      }

      if (foundDisplay && foundDisplay !== "") {
        return {
          display: foundDisplay,
          xauthority: foundXauth && foundXauth !== "" ? foundXauth : undefined,
        };
      }
    }
  } catch {
    // ignore
  }

  return { display: ":0" };
}

/**
 * Opens the SVG in Chrome detached without blocking agents.
 * When it cannot open, prints the file's path and carries on cleanly.
 */
export async function openProgressSvgInChrome(svgPath: string): Promise<void> {
  const absPath = path.resolve(svgPath);

  if (Deno.env.get("HEALTH_REPORT_SKIP_CHROME") === "1") {
    return;
  }

  const customCmd = Deno.env.get("HEALTH_REPORT_CHROME_CMD");
  if (customCmd) {
    try {
      const child = new Deno.Command("bash", {
        args: ["-c", customCmd],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      child.unref();
      return;
    } catch {
      console.log(absPath);
      return;
    }
  }

  const { display, xauthority } = await resolveDisplayEnv();
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    DISPLAY: display,
  };
  if (xauthority) {
    env.XAUTHORITY = xauthority;
  }

  const fileUrl = `file://${absPath}`;
  const candidates = ["google-chrome"];

  let opened = false;
  for (const bin of candidates) {
    try {
      const child = new Deno.Command(bin, {
        args: [fileUrl],
        env,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      child.unref();
      opened = true;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!opened) {
    // When it cannot open, the terminal prints the file's path and agents carries on
    console.log(absPath);
  }
}
