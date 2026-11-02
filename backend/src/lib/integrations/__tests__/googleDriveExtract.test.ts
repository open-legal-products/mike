import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { Document, Packer, Paragraph } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractGoogleDriveBinary } from "../googleDriveExtract";

const directories: string[] = [];
async function fixture(bytes: Buffer) {
    const directory = await mkdtemp(
        path.join(os.tmpdir(), "drive-parser-test-"),
    );
    directories.push(directory);
    const filename = path.join(directory, "file");
    await writeFile(filename, bytes);
    return filename;
}
afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        directories
            .splice(0)
            .map((d) => rm(d, { recursive: true, force: true })),
    );
});

describe("isolated Google Drive document parsing", () => {
    it("extracts a real DOCX in the child process", async () => {
        const doc = new Document({
            sections: [
                {
                    children: [
                        new Paragraph("MIKE434 liability cap USD 43,210"),
                    ],
                },
            ],
        });
        const filename = await fixture(await Packer.toBuffer(doc));
        expect(
            await extractGoogleDriveBinary(
                filename,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
        ).toContain("USD 43,210");
    });
    it("extracts a real PDF in the child process", async () => {
        const content =
            "BT /F1 12 Tf 72 720 Td (MIKE434 payment 17 days) Tj ET";
        const objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
            `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ];
        let pdf = "%PDF-1.7\n";
        const offsets = [0];
        objects.forEach((object, i) => {
            offsets.push(Buffer.byteLength(pdf));
            pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
        });
        const xref = Buffer.byteLength(pdf);
        pdf += `xref\n0 6\n0000000000 65535 f \n`;
        for (const offset of offsets.slice(1))
            pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
        pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
        expect(
            await extractGoogleDriveBinary(
                await fixture(Buffer.from(pdf)),
                "application/pdf",
            ),
        ).toContain("payment 17 days");
    });
    it("rejects expanded DOCX content above the configured budget", async () => {
        vi.stubEnv("GOOGLE_DRIVE_DOCX_EXPANDED_MB", "1");
        const zip = new JSZip();
        zip.file("word/document.xml", "x".repeat(2 * 1024 * 1024));
        const filename = await fixture(
            await zip.generateAsync({
                type: "nodebuffer",
                compression: "DEFLATE",
            }),
        );
        await expect(
            extractGoogleDriveBinary(
                filename,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
        ).rejects.toThrow(/processing limits/);
    });
    it("returns a controlled failure for malformed DOCX without leaking parser details", async () => {
        await expect(
            extractGoogleDriveBinary(
                await fixture(Buffer.from("bad zip secret-sentinel")),
                "docx",
            ),
        ).rejects.toThrow(
            "This Drive file could not be read within the processing limits. Open it in Google Drive.",
        );
    });
});
