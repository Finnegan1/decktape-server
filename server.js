import express from "express";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// CORS middleware
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Increase the limit for JSON body size
app.use(bodyParser.json({ limit: "50mb" }));

// Extensive logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log("Headers:", req.headers);
  console.log("Body size:", req.get("content-length") || "0", "bytes");

  // Log response
  const originalSend = res.send;
  res.send = function (data) {
    console.log(
      `[${new Date().toISOString()}] Response status:`,
      res.statusCode
    );
    console.log("Response headers:", res.getHeaders());
    return originalSend.call(this, data);
  };

  next();
});

app.post("/convert", async (req, res) => {
  let tmpDir = null;
  try {
    const { html, options = {} } = req.body;

    if (!html) {
      return res.status(400).json({ error: "HTML content is required" });
    }

    // Create temporary files for input and output
    tmpDir = await fs.mkdtemp(join(os.tmpdir(), "decktape-"));
    const htmlPath = join(tmpDir, "input.html");
    const pdfPath = join(tmpDir, "output.pdf");

    await fs.writeFile(htmlPath, html);

    // Prepare decktape command with Chrome configuration
    const decktapePath = join(__dirname, "decktape.js");
    const chromePath = process.env.CHROME_PATH || "/usr/bin/chromium-browser";
    const chromeFlags = (
      process.env.CHROME_FLAGS || "--no-sandbox,--disable-gpu"
    ).split(",");

    const args = [
      decktapePath,
      "--chrome-path",
      chromePath,
      ...chromeFlags.map((flag) => `--chrome-arg=${flag}`),
      "generic",
      `file://${htmlPath}`,
      pdfPath,
      "--key=ArrowDown",
      "--key=ArrowRight",
      ...(options.size ? [`--size=${options.size}`] : []),
      ...(options.pause ? [`--pause=${options.pause}`] : []),
    ];

    console.log("Executing command:", "node", args.join(" "));

    return new Promise((resolve, reject) => {
      const decktape = spawn("node", args);

      let stderr = "";
      let stdout = "";

      decktape.stderr.on("data", (data) => {
        stderr += data.toString();
        console.error(`Decktape stderr: ${data}`);
      });

      decktape.stdout.on("data", (data) => {
        stdout += data.toString();
        console.log(`Decktape stdout: ${data}`);
      });

      decktape.on("error", (error) => {
        console.error("Failed to start Decktape process:", error);
        reject(error);
      });

      decktape.on("close", async (code) => {
        try {
          if (code !== 0) {
            console.error(`Decktape process exited with code ${code}`);
            console.error(`stderr: ${stderr}`);
            console.error(`stdout: ${stdout}`);
            return reject(new Error(`Decktape failed: ${stderr || stdout}`));
          }

          // Read the generated PDF
          const pdfBuffer = await fs.readFile(pdfPath);

          // Send PDF as response
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader(
            "Content-Disposition",
            "attachment; filename=presentation.pdf"
          );
          res.send(pdfBuffer);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          // Cleanup temporary files
          if (tmpDir) {
            try {
              await fs.rm(tmpDir, { recursive: true, force: true });
            } catch (error) {
              console.error("Error cleaning up temporary files:", error);
            }
          }
        }
      });
    }).catch((error) => {
      console.error("Error in PDF conversion:", error);
      res.status(500).json({
        error: "PDF conversion failed",
        details: error.message,
        stdout,
        stderr,
      });
    });
  } catch (error) {
    console.error("Conversion error:", error);
    res
      .status(500)
      .json({ error: "PDF conversion failed", details: error.message });
    // Cleanup temporary files in case of error
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error("Error cleaning up temporary files:", cleanupError);
      }
    }
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
