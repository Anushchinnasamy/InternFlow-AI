import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface ConfirmationLetterPdfData {
  candidateName: string;
  nonWorkerId: string;
  mentorName: string;
  projectTitle: string;
  startDate: Date;
  endDate: Date;
  site: string;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function generateConfirmationLetterPdf(data: ConfirmationLetterPdfData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const line = (text: string, size = 11, useBold = false) => {
    page.drawText(text, { x: 50, y, size, font: useBold ? bold : font, color: rgb(0, 0, 0) });
    y -= size + 8;
  };

  line("INTERNSHIP CONFIRMATION LETTER", 16, true);
  y -= 10;
  line(`Candidate: ${data.candidateName}`);
  line(`Non-Worker ID: ${data.nonWorkerId}`);
  line(`Mentor: ${data.mentorName}`);
  line(`Project: ${data.projectTitle}`);
  line(`Site: ${data.site}`);
  line(`Internship period: ${formatDate(data.startDate)} to ${formatDate(data.endDate)}`);
  y -= 10;

  const clause = [
    "This letter confirms the above-named individual's participation in an unpaid",
    "internship program. This is an unpaid internship; no employment relationship,",
    "wages, or benefits are created or implied by this internship or this letter.",
  ];
  for (const clauseLine of clause) {
    line(clauseLine, 10);
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
