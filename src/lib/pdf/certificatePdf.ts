import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface CertificatePdfData {
  candidateName: string;
  projectTitle: string;
  mentorName: string;
  startDate: Date;
  endDate: Date;
  referenceNumber: string;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function generateCertificatePdf(data: CertificatePdfData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 700;
  const line = (text: string, size = 12, useBold = false) => {
    page.drawText(text, { x: 50, y, size, font: useBold ? bold : font, color: rgb(0, 0, 0) });
    y -= size + 10;
  };

  line("CERTIFICATE OF INTERNSHIP COMPLETION", 18, true);
  y -= 20;
  line(`This certifies that ${data.candidateName}`, 13);
  line(`successfully completed an internship on "${data.projectTitle}"`, 13);
  line(`under the mentorship of ${data.mentorName},`, 13);
  line(`from ${formatDate(data.startDate)} to ${formatDate(data.endDate)}.`, 13);
  y -= 20;
  line(`Reference: ${data.referenceNumber}`, 11);

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
