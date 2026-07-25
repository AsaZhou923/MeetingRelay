use std::{error::Error, fmt};

#[cfg(test)]
use std::collections::BTreeMap;

pub const MAX_DOCUMENT_TITLE_CHARS: usize = 256;
pub const MAX_SECTIONS: usize = 128;
pub const MAX_PARAGRAPHS: usize = 10_000;
pub const MAX_PARAGRAPH_CHARS: usize = 16_384;
pub const MAX_DOCUMENT_CHARS: usize = 2_000_000;
pub const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentModel {
    pub title: String,
    pub sections: Vec<Section>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Section {
    pub heading: Option<String>,
    pub paragraphs: Vec<Paragraph>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Paragraph {
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DocumentExportError {
    EmptyDocument,
    TitleTooLong,
    TooManySections,
    TooManyParagraphs,
    ParagraphTooLong,
    DocumentTooLarge,
    OutputTooLarge,
}

impl fmt::Display for DocumentExportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyDocument => f.write_str("document has no paragraphs"),
            Self::TitleTooLong => f.write_str("document title exceeds the character limit"),
            Self::TooManySections => f.write_str("document has too many sections"),
            Self::TooManyParagraphs => f.write_str("document has too many paragraphs"),
            Self::ParagraphTooLong => f.write_str("a paragraph exceeds the character limit"),
            Self::DocumentTooLarge => f.write_str("document text exceeds the character limit"),
            Self::OutputTooLarge => f.write_str("rendered document exceeds the byte limit"),
        }
    }
}

impl Error for DocumentExportError {}

impl DocumentModel {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            sections: Vec::new(),
        }
    }

    pub fn with_section(mut self, section: Section) -> Self {
        self.sections.push(section);
        self
    }

    pub fn validate(&self) -> Result<DocumentStats, DocumentExportError> {
        let title_chars = self.title.chars().count();
        if title_chars > MAX_DOCUMENT_TITLE_CHARS {
            return Err(DocumentExportError::TitleTooLong);
        }
        if self.sections.len() > MAX_SECTIONS {
            return Err(DocumentExportError::TooManySections);
        }

        let mut paragraph_count = 0usize;
        let mut char_count = title_chars;
        for section in &self.sections {
            if let Some(heading) = &section.heading {
                char_count = char_count.saturating_add(heading.chars().count());
            }
            for paragraph in &section.paragraphs {
                let paragraph_chars = paragraph.text.chars().count();
                if paragraph_chars > MAX_PARAGRAPH_CHARS {
                    return Err(DocumentExportError::ParagraphTooLong);
                }
                paragraph_count = paragraph_count.saturating_add(1);
                char_count = char_count.saturating_add(paragraph_chars);
            }
        }

        if paragraph_count == 0 {
            return Err(DocumentExportError::EmptyDocument);
        }
        if paragraph_count > MAX_PARAGRAPHS {
            return Err(DocumentExportError::TooManyParagraphs);
        }
        if char_count > MAX_DOCUMENT_CHARS {
            return Err(DocumentExportError::DocumentTooLarge);
        }

        Ok(DocumentStats {
            title_chars,
            section_count: self.sections.len(),
            paragraph_count,
            char_count,
        })
    }
}

impl Section {
    pub fn new(heading: impl Into<String>) -> Self {
        Self {
            heading: Some(heading.into()),
            paragraphs: Vec::new(),
        }
    }

    #[allow(dead_code)]
    pub fn untitled() -> Self {
        Self {
            heading: None,
            paragraphs: Vec::new(),
        }
    }

    pub fn with_paragraph(mut self, text: impl Into<String>) -> Self {
        self.paragraphs.push(Paragraph { text: text.into() });
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentStats {
    pub title_chars: usize,
    pub section_count: usize,
    pub paragraph_count: usize,
    pub char_count: usize,
}

pub fn render_docx(document: &DocumentModel) -> Result<Vec<u8>, DocumentExportError> {
    let stats = document.validate()?;
    let manifest = source_manifest(document, stats);
    let mut zip = ZipWriter::new();
    zip.add_file("[Content_Types].xml", content_types_xml().into_bytes());
    zip.add_file("_rels/.rels", package_relationships_xml().into_bytes());
    zip.add_file("docProps/core.xml", core_xml(&document.title).into_bytes());
    zip.add_file(
        "word/_rels/document.xml.rels",
        document_relationships_xml().into_bytes(),
    );
    zip.add_file("customXml/item1.xml", manifest_xml(&manifest).into_bytes());
    zip.add_file("word/document.xml", document_xml(document).into_bytes());
    bounded_output(zip.finish())
}

pub fn render_pdf(document: &DocumentModel) -> Result<Vec<u8>, DocumentExportError> {
    let stats = document.validate()?;
    let manifest = source_manifest(document, stats);
    bounded_output(PdfWriter::from_document(document, &manifest).finish())
}

fn bounded_output(bytes: Vec<u8>) -> Result<Vec<u8>, DocumentExportError> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        Err(DocumentExportError::OutputTooLarge)
    } else {
        Ok(bytes)
    }
}

fn content_types_xml() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>"#
        .to_owned()
}

fn package_relationships_xml() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>"#
        .to_owned()
}

fn document_relationships_xml() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdManifest" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>
</Relationships>"#
        .to_owned()
}

fn core_xml(title: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
<dc:title>{}</dc:title>
<dc:creator>MeetingRelay</dc:creator>
</cp:coreProperties>"#,
        xml_escape(title)
    )
}

fn document_xml(document: &DocumentModel) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>"#,
    );
    if !document.title.is_empty() {
        push_docx_paragraph(&mut xml, &document.title, "Title");
    }
    for section in &document.sections {
        if let Some(heading) = &section.heading
            && !heading.is_empty()
        {
            push_docx_paragraph(&mut xml, heading, "Heading1");
        }
        for paragraph in &section.paragraphs {
            push_docx_paragraph(&mut xml, &paragraph.text, "Normal");
        }
    }
    xml.push_str("<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr></w:body></w:document>");
    xml
}

fn push_docx_paragraph(xml: &mut String, text: &str, style: &str) {
    xml.push_str("<w:p><w:pPr><w:pStyle w:val=\"");
    xml.push_str(style);
    xml.push_str("\"/></w:pPr><w:r><w:t xml:space=\"preserve\">");
    xml.push_str(&xml_escape(text));
    xml.push_str("</w:t></w:r></w:p>");
}

fn manifest_xml(manifest: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><meetingrelay-source-manifest>{}</meetingrelay-source-manifest>",
        xml_escape(manifest)
    )
}

fn source_manifest(document: &DocumentModel, stats: DocumentStats) -> String {
    let mut json = String::from("{\"format\":\"meetingrelay.document-source.v1\"");
    json.push_str(&format!(
        ",\"stats\":{{\"titleChars\":{},\"sections\":{},\"paragraphs\":{},\"chars\":{}}}",
        stats.title_chars, stats.section_count, stats.paragraph_count, stats.char_count
    ));
    json.push_str(",\"title\":\"");
    json.push_str(&json_escape(&document.title));
    json.push_str("\",\"sections\":[");
    for (section_index, section) in document.sections.iter().enumerate() {
        if section_index > 0 {
            json.push(',');
        }
        json.push_str("{\"heading\":");
        match &section.heading {
            Some(heading) => {
                json.push('"');
                json.push_str(&json_escape(heading));
                json.push('"');
            }
            None => json.push_str("null"),
        }
        json.push_str(",\"paragraphs\":[");
        for (paragraph_index, paragraph) in section.paragraphs.iter().enumerate() {
            if paragraph_index > 0 {
                json.push(',');
            }
            json.push('"');
            json.push_str(&json_escape(&paragraph.text));
            json.push('"');
        }
        json.push_str("]}");
    }
    json.push_str("]}");
    json
}

fn xml_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' => escaped.push(' '),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn json_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\u{8}' => escaped.push_str("\\b"),
            '\u{c}' => escaped.push_str("\\f"),
            '\u{0}'..='\u{1f}' => escaped.push_str(&format!("\\u{:04x}", u32::from(ch))),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[derive(Clone, Debug)]
struct ZipEntry {
    name: String,
    data: Vec<u8>,
    crc32: u32,
    local_offset: u32,
}

#[derive(Default)]
struct ZipWriter {
    entries: Vec<ZipEntry>,
}

impl ZipWriter {
    fn new() -> Self {
        Self::default()
    }

    fn add_file(&mut self, name: &str, data: Vec<u8>) {
        self.entries.push(ZipEntry {
            name: name.to_owned(),
            crc32: crc32(&data),
            data,
            local_offset: 0,
        });
    }

    fn finish(mut self) -> Vec<u8> {
        let mut out = Vec::new();
        for entry in &mut self.entries {
            entry.local_offset = u32_from_usize(out.len());
            write_zip_local_header(&mut out, entry);
            out.extend_from_slice(&entry.data);
        }
        let central_offset = u32_from_usize(out.len());
        for entry in &self.entries {
            write_zip_central_header(&mut out, entry);
        }
        let central_size = u32_from_usize(out.len() - central_offset as usize);
        write_u32(&mut out, 0x0605_4b50);
        write_u16(&mut out, 0);
        write_u16(&mut out, 0);
        write_u16(&mut out, self.entries.len() as u16);
        write_u16(&mut out, self.entries.len() as u16);
        write_u32(&mut out, central_size);
        write_u32(&mut out, central_offset);
        write_u16(&mut out, 0);
        out
    }
}

fn write_zip_local_header(out: &mut Vec<u8>, entry: &ZipEntry) {
    let name = entry.name.as_bytes();
    write_u32(out, 0x0403_4b50);
    write_u16(out, 20);
    write_u16(out, 0);
    write_u16(out, 0);
    write_u16(out, 0);
    write_u16(out, 33);
    write_u32(out, entry.crc32);
    write_u32(out, u32_from_usize(entry.data.len()));
    write_u32(out, u32_from_usize(entry.data.len()));
    write_u16(out, name.len() as u16);
    write_u16(out, 0);
    out.extend_from_slice(name);
}

fn write_zip_central_header(out: &mut Vec<u8>, entry: &ZipEntry) {
    let name = entry.name.as_bytes();
    write_u32(out, 0x0201_4b50);
    write_u16(out, 20);
    write_u16(out, 20);
    write_u16(out, 0);
    write_u16(out, 0);
    write_u16(out, 0);
    write_u16(out, 33);
    write_u32(out, entry.crc32);
    write_u32(out, u32_from_usize(entry.data.len()));
    write_u32(out, u32_from_usize(entry.data.len()));
    write_u16(out, name.len() as u16);
    write_u16(out, 0);
    write_u16(out, 0);
    write_u16(out, 0);
    write_u16(out, 0);
    write_u32(out, 0);
    write_u32(out, entry.local_offset);
    out.extend_from_slice(name);
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn write_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn write_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn u32_from_usize(value: usize) -> u32 {
    u32::try_from(value).expect("validated output fits ZIP32/PDF offsets")
}

#[derive(Clone, Debug)]
struct PdfPage {
    lines: Vec<PdfLine>,
}

#[derive(Clone, Debug)]
struct PdfLine {
    size: f32,
    height: f32,
    fragments: Vec<PdfFragment>,
}

#[derive(Clone, Debug)]
struct PdfFragment {
    font: PdfFont,
    text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PdfFont {
    Latin,
    Chinese,
    Japanese,
}

struct PdfWriter {
    objects: Vec<Vec<u8>>,
    catalog_object: usize,
}

const PDF_PAGE_HEIGHT: f32 = 842.0;
const PDF_MARGIN_LEFT: f32 = 72.0;
const PDF_MARGIN_TOP: f32 = 72.0;
const PDF_MARGIN_BOTTOM: f32 = 72.0;
const PDF_TEXT_WIDTH: f32 = 470.0;
const PDF_FIRST_BASELINE: f32 = PDF_PAGE_HEIGHT - PDF_MARGIN_TOP;
const PDF_MIN_BASELINE: f32 = PDF_MARGIN_BOTTOM;
const PDF_TEXT_HEIGHT: f32 = PDF_FIRST_BASELINE - PDF_MIN_BASELINE;

impl PdfWriter {
    fn from_document(document: &DocumentModel, manifest: &str) -> Self {
        let pages = paginate(document);
        let mut writer = Self {
            objects: vec![Vec::new()],
            catalog_object: 1,
        };
        writer.objects.push(Vec::new());
        writer.objects.push(Vec::new());
        let latin_font = writer.add_object(
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
                .to_vec(),
        );
        let chinese_descendant = writer.add_object(b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >> >>".to_vec());
        let chinese_font = writer.add_object(format!("<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [{} 0 R] >>", chinese_descendant).into_bytes());
        let japanese_descendant = writer.add_object(b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> /FontDescriptor << /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >> >>".to_vec());
        let japanese_font = writer.add_object(format!("<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H /DescendantFonts [{} 0 R] >>", japanese_descendant).into_bytes());
        let manifest_stream = pdf_stream(manifest.as_bytes());
        let manifest_object = writer.add_object(manifest_stream);
        let filespec_object = writer.add_object(format!("<< /Type /Filespec /F (source-manifest.json) /UF <{}> /EF << /F {} 0 R /UF {} 0 R >> >>", utf16_hex("source-manifest.json"), manifest_object, manifest_object).into_bytes());

        let mut page_objects = Vec::new();
        for page in pages {
            let content_object =
                writer.add_object(pdf_stream(render_pdf_page_content(&page).as_bytes()));
            let page_object = writer.add_object(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 {} 0 R /F2 {} 0 R /F3 {} 0 R >> >> /Contents {} 0 R >>", latin_font, chinese_font, japanese_font, content_object).into_bytes());
            page_objects.push(page_object);
        }

        writer.objects[1] = format!("<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(source-manifest.json) {} 0 R] >> >> >>", filespec_object).into_bytes();
        writer.objects[2] = format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            page_objects
                .iter()
                .map(|id| format!("{id} 0 R"))
                .collect::<Vec<_>>()
                .join(" "),
            page_objects.len()
        )
        .into_bytes();
        writer
    }

    fn add_object(&mut self, object: Vec<u8>) -> usize {
        let id = self.objects.len();
        self.objects.push(object);
        id
    }

    fn finish(self) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
        let mut offsets = vec![0usize; self.objects.len()];
        for (id, object) in self.objects.iter().enumerate().skip(1) {
            offsets[id] = out.len();
            out.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
            out.extend_from_slice(object);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref_offset = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", self.objects.len()).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root {} 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
                self.objects.len(),
                self.catalog_object
            )
            .as_bytes(),
        );
        out
    }
}

fn paginate(document: &DocumentModel) -> Vec<PdfPage> {
    let mut pages = Vec::new();
    let mut current = PdfPage { lines: Vec::new() };
    push_wrapped_lines(&mut pages, &mut current, &document.title, 18.0, true);
    for section in &document.sections {
        if let Some(heading) = &section.heading {
            push_wrapped_lines(&mut pages, &mut current, heading, 15.0, true);
        }
        for paragraph in &section.paragraphs {
            push_wrapped_lines(&mut pages, &mut current, &paragraph.text, 11.0, false);
        }
    }
    if current.lines.is_empty() {
        current.lines.push(PdfLine {
            size: 11.0,
            height: line_height(11.0),
            fragments: vec![PdfFragment {
                font: PdfFont::Latin,
                text: String::new(),
            }],
        });
    }
    pages.push(current);
    pages
}

fn push_wrapped_lines(
    pages: &mut Vec<PdfPage>,
    current: &mut PdfPage,
    text: &str,
    size: f32,
    extra_gap: bool,
) {
    let mut lines = wrapped_pdf_lines(text, size);
    if extra_gap {
        lines.push(make_pdf_line("", 5.0));
    }
    push_pdf_line_block(pages, current, lines);
}

fn wrapped_pdf_lines(text: &str, size: f32) -> Vec<PdfLine> {
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut line_width = 0.0;
    let mut break_byte = None;
    for ch in text.chars() {
        if ch == '\n' {
            lines.push(make_pdf_line(line.trim_end(), size));
            line.clear();
            line_width = 0.0;
            break_byte = None;
            continue;
        }

        let width = char_width(ch, size);
        if !line.is_empty() && line_width + width > PDF_TEXT_WIDTH {
            if let Some(index) = break_byte {
                let wrapped = line[..index].trim_end().to_owned();
                let remainder = line[index..].trim_start().to_owned();
                lines.push(make_pdf_line(&wrapped, size));
                line = remainder;
                line_width = text_width(&line, size);
            } else {
                lines.push(make_pdf_line(&line, size));
                line.clear();
                line_width = 0.0;
            }
            break_byte = None;
        }

        line.push(ch);
        line_width += width;
        if ch.is_whitespace() || is_cjk_break_char(ch) {
            break_byte = Some(line.len());
        }
    }
    lines.push(make_pdf_line(line.trim_end(), size));
    lines
}

fn push_pdf_line_block(pages: &mut Vec<PdfPage>, current: &mut PdfPage, lines: Vec<PdfLine>) {
    let block_height = lines.iter().map(|line| line.height).sum::<f32>();
    if block_height <= PDF_TEXT_HEIGHT
        && !current.lines.is_empty()
        && used_pdf_height(current) + block_height > PDF_TEXT_HEIGHT
    {
        pages.push(std::mem::replace(current, PdfPage { lines: Vec::new() }));
    }
    for line in lines {
        push_pdf_line(pages, current, line);
    }
}

fn push_pdf_line(pages: &mut Vec<PdfPage>, current: &mut PdfPage, line: PdfLine) {
    let height = line.height;
    if !current.lines.is_empty() && used_pdf_height(current) + height > PDF_TEXT_HEIGHT {
        pages.push(std::mem::replace(current, PdfPage { lines: Vec::new() }));
    }
    current.lines.push(line);
}

fn make_pdf_line(text: &str, size: f32) -> PdfLine {
    PdfLine {
        size,
        height: line_height(size),
        fragments: pdf_fragments(text),
    }
}

fn used_pdf_height(page: &PdfPage) -> f32 {
    page.lines.iter().map(|line| line.height).sum()
}

fn line_height(size: f32) -> f32 {
    if size <= 5.0 { 8.0 } else { size + 4.0 }
}

fn char_width(ch: char, size: f32) -> f32 {
    if ch.is_ascii() {
        if ch == ' ' { size * 0.32 } else { size * 0.55 }
    } else {
        size
    }
}

fn text_width(text: &str, size: f32) -> f32 {
    text.chars().map(|ch| char_width(ch, size)).sum()
}

fn is_cjk_break_char(ch: char) -> bool {
    ('\u{3040}'..='\u{30ff}').contains(&ch)
        || ('\u{31f0}'..='\u{31ff}').contains(&ch)
        || ('\u{3400}'..='\u{9fff}').contains(&ch)
        || ('\u{f900}'..='\u{faff}').contains(&ch)
}

fn pdf_fragments(text: &str) -> Vec<PdfFragment> {
    let mut fragments = Vec::new();
    let mut current_font = None;
    let mut current_text = String::new();
    for ch in text.chars() {
        let font = pdf_font_for_char(ch);
        if current_font == Some(font) || current_font.is_none() {
            current_font = Some(font);
            current_text.push(ch);
        } else {
            fragments.push(PdfFragment {
                font: current_font.expect("font is set"),
                text: std::mem::take(&mut current_text),
            });
            current_font = Some(font);
            current_text.push(ch);
        }
    }
    if !current_text.is_empty() || text.is_empty() {
        fragments.push(PdfFragment {
            font: current_font.unwrap_or(PdfFont::Latin),
            text: current_text,
        });
    }
    fragments
}

fn pdf_font_for_char(ch: char) -> PdfFont {
    if ch.is_ascii() {
        PdfFont::Latin
    } else if ('\u{3040}'..='\u{30ff}').contains(&ch) || ('\u{31f0}'..='\u{31ff}').contains(&ch) {
        PdfFont::Japanese
    } else {
        PdfFont::Chinese
    }
}

fn render_pdf_page_content(page: &PdfPage) -> String {
    let mut content = String::from("BT\n");
    let mut y = PDF_FIRST_BASELINE;
    for line in &page.lines {
        let mut x = PDF_MARGIN_LEFT;
        for fragment in &line.fragments {
            content.push_str(&format!("1 0 0 1 {x:.1} {y:.1} Tm\n"));
            match fragment.font {
                PdfFont::Latin => content.push_str(&format!(
                    "/F1 {:.1} Tf ({}) Tj\n",
                    line.size,
                    pdf_literal_escape(&fragment.text)
                )),
                PdfFont::Chinese => content.push_str(&format!(
                    "/F2 {:.1} Tf <{}> Tj\n",
                    line.size,
                    utf16_hex(&fragment.text)
                )),
                PdfFont::Japanese => content.push_str(&format!(
                    "/F3 {:.1} Tf <{}> Tj\n",
                    line.size,
                    utf16_hex(&fragment.text)
                )),
            }
            x += text_width(&fragment.text, line.size);
        }
        y -= line.height;
    }
    content.push_str("ET\n");
    content
}

fn pdf_stream(data: &[u8]) -> Vec<u8> {
    let mut object = format!("<< /Length {} >>\nstream\n", data.len()).into_bytes();
    object.extend_from_slice(data);
    object.extend_from_slice(b"\nendstream");
    object
}

fn pdf_literal_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'(' => escaped.push_str("\\("),
            b')' => escaped.push_str("\\)"),
            b'\\' => escaped.push_str("\\\\"),
            b'\n' => escaped.push_str("\\n"),
            b'\r' => escaped.push_str("\\r"),
            b'\t' => escaped.push_str("\\t"),
            0x08 => escaped.push_str("\\b"),
            0x0c => escaped.push_str("\\f"),
            0x20..=0x7e => escaped.push(char::from(byte)),
            _ => escaped.push_str(&format!("\\{:03o}", byte)),
        }
    }
    escaped
}

fn utf16_hex(text: &str) -> String {
    let mut hex = String::with_capacity(text.len() * 4);
    for unit in text.encode_utf16() {
        hex.push_str(&format!("{unit:04X}"));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docx_zip_parts_have_valid_crc_and_expected_ooxml_files() {
        let document = sample_document();
        let bytes = render_docx(&document).unwrap();
        let files = read_zip_files(&bytes);
        assert!(files.contains_key("[Content_Types].xml"));
        assert!(files.contains_key("_rels/.rels"));
        assert!(files.contains_key("word/document.xml"));
        assert!(files.contains_key("customXml/item1.xml"));
        assert_eq!(
            String::from_utf8(files["word/document.xml"].clone())
                .unwrap()
                .matches("<w:p>")
                .count(),
            6
        );
    }

    #[test]
    fn docx_escapes_xml_and_embeds_utf8_source_manifest() {
        let document = DocumentModel::new("A&B <Title>").with_section(
            Section::new("Quotes")
                .with_paragraph("one < two & \"quoted\"")
                .with_paragraph("中文と日本語 plus English"),
        );
        let files = read_zip_files(&render_docx(&document).unwrap());
        let document_xml = String::from_utf8(files["word/document.xml"].clone()).unwrap();
        assert!(document_xml.contains("A&amp;B &lt;Title&gt;"));
        assert!(document_xml.contains("one &lt; two &amp; &quot;quoted&quot;"));
        let manifest = String::from_utf8(files["customXml/item1.xml"].clone()).unwrap();
        assert!(manifest.contains("中文と日本語 plus English"));
        assert!(manifest.contains("&quot;paragraphs&quot;:2"));
    }

    #[test]
    fn pdf_has_valid_xref_page_count_fonts_and_embedded_manifest() {
        let document = sample_document();
        let bytes = render_pdf(&document).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%PDF-1.7"));
        assert!(text.contains("/Type /Catalog"));
        assert!(text.contains("/BaseFont /Helvetica"));
        assert!(text.contains("/BaseFont /STSong-Light"));
        assert!(text.contains("/BaseFont /HeiseiKakuGo-W5"));
        assert!(text.contains("/Encoding /UniGB-UCS2-H"));
        assert!(text.contains("/Encoding /UniJIS-UCS2-H"));
        assert!(text.contains("/Count 1"));
        assert!(text.contains("source-manifest.json"));
        assert!(text.contains("meetingrelay.document-source.v1"));
        assert_xref_offsets_are_correct(&bytes);
    }

    #[test]
    fn pdf_escapes_latin_literals_and_hex_encodes_cjk_text() {
        let document = DocumentModel::new("PDF (escape) \\ test")
            .with_section(Section::new("Mixed").with_paragraph("A (B) \\ C 中文かな English"));
        let bytes = render_pdf(&document).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains(r"PDF \(escape\) \\ test"));
        assert!(text.contains(r"A \(B\) \\ C "));
        assert!(text.contains(&utf16_hex("中文")));
        assert!(text.contains(&utf16_hex("かな")));
    }

    #[test]
    fn pdf_layout_advances_mixed_font_fragments_without_overlap() {
        let page = PdfPage {
            lines: vec![
                PdfLine {
                    size: 11.0,
                    height: line_height(11.0),
                    fragments: pdf_fragments("ABC 中文かな English"),
                },
                PdfLine {
                    size: 11.0,
                    height: line_height(11.0),
                    fragments: pdf_fragments("second line"),
                },
            ],
        };

        let content = render_pdf_page_content(&page);
        assert!(!content.contains("2 0 Td"));
        let matrices = text_matrices(&content);
        assert_eq!(matrices[0], (PDF_MARGIN_LEFT, PDF_FIRST_BASELINE));
        assert_eq!(
            matrices[4],
            (PDF_MARGIN_LEFT, PDF_FIRST_BASELINE - line_height(11.0))
        );

        let first_line_fragments = &page.lines[0].fragments;
        let mut expected_x = PDF_MARGIN_LEFT;
        for (index, fragment) in first_line_fragments.iter().enumerate() {
            assert_eq!(matrices[index].1, PDF_FIRST_BASELINE);
            assert!(
                (matrices[index].0 - expected_x).abs() < 0.05,
                "fragment {index} starts at {}, expected {expected_x}",
                matrices[index].0
            );
            expected_x += text_width(&fragment.text, page.lines[0].size);
        }
    }

    #[test]
    fn pdf_layout_wraps_cjk_latin_lines_within_text_width() {
        let paragraph = "Intro English words mixed with 中文内容和日本語かなカナ plus averyveryveryveryveryverylongword repeated 中文日本語かなカナ end marker";
        let document = DocumentModel::new("Wrap")
            .with_section(Section::new("Mixed wrapping").with_paragraph(paragraph.repeat(8)));

        let pages = paginate(&document);
        let visible_lines = rendered_line_text(&pages);
        assert!(visible_lines.first().unwrap().contains("Wrap"));
        assert!(visible_lines.last().unwrap().contains("marker"));
        assert!(
            visible_lines.len() > 4,
            "mixed paragraph should wrap into multiple lines"
        );

        for page in &pages {
            for line in &page.lines {
                let line_text = line
                    .fragments
                    .iter()
                    .map(|fragment| fragment.text.as_str())
                    .collect::<String>();
                assert!(
                    text_width(&line_text, line.size) <= PDF_TEXT_WIDTH + 0.1,
                    "line exceeds PDF text width: {line_text}"
                );
            }
        }
    }

    #[test]
    fn pdf_layout_paginates_by_line_height_inside_printable_area() {
        let mut section = Section::new("Pagination");
        for index in 0..120 {
            section = section.with_paragraph(format!(
                "paragraph-{index:03} 中文日本語かなカナ English wrap wrap wrap"
            ));
        }
        let pages = paginate(&DocumentModel::new("Paged").with_section(section));

        assert!(
            pages.len() >= 3,
            "expected multiple pages, got {}",
            pages.len()
        );
        for page in &pages {
            let matrices = text_matrices(&render_pdf_page_content(page));
            assert_eq!(
                matrices.len(),
                page.lines
                    .iter()
                    .map(|line| line.fragments.len())
                    .sum::<usize>()
            );
            let mut expected_y = PDF_FIRST_BASELINE;
            for line in &page.lines {
                let line_fragment_count = line.fragments.len();
                let line_matrices = matrices
                    .iter()
                    .filter(|(_, y)| (*y - expected_y).abs() < 0.05)
                    .count();
                assert_eq!(line_matrices, line_fragment_count);
                assert!(
                    expected_y >= PDF_MIN_BASELINE,
                    "line baseline {expected_y} is below printable area"
                );
                expected_y -= line.height;
            }
        }
    }

    #[test]
    fn pdf_layout_keeps_fitting_paragraph_blocks_together_across_page_breaks() {
        let mut section = Section::new("Block pagination");
        for index in 0..45 {
            section = section.with_paragraph(format!("filler-{index:03}"));
        }
        section = section.with_paragraph(
            "boundary-block 中文日本語かなカナ English wrapping should stay together when it fits on a fresh page but not in the remaining space",
        );

        let pages = paginate(&DocumentModel::new("Boundary").with_section(section));
        let block_lines = pages
            .iter()
            .enumerate()
            .flat_map(|(page_index, page)| {
                page.lines.iter().map(move |line| {
                    (
                        page_index,
                        line.fragments
                            .iter()
                            .map(|fragment| fragment.text.as_str())
                            .collect::<String>(),
                    )
                })
            })
            .filter(|(_, text)| {
                text.contains("boundary-block")
                    || text.contains("fresh page")
                    || text.contains("remaining space")
            })
            .collect::<Vec<_>>();

        assert!(block_lines.len() >= 2, "boundary paragraph should wrap");
        let block_page = block_lines[0].0;
        assert!(
            block_lines
                .iter()
                .all(|(page_index, _)| *page_index == block_page),
            "fitting paragraph block was split across pages: {block_lines:?}"
        );
    }

    #[test]
    fn long_text_is_paginated_and_preserves_every_paragraph_in_manifests() {
        let mut section = Section::new("Long");
        for index in 0..130 {
            section = section.with_paragraph(format!("paragraph-{index:03} 中文 日本語 English"));
        }
        let document = DocumentModel::new("Long Export").with_section(section);

        let docx = render_docx(&document).unwrap();
        let files = read_zip_files(&docx);
        let docx_manifest = String::from_utf8(files["customXml/item1.xml"].clone()).unwrap();
        assert!(docx_manifest.contains("&quot;paragraphs&quot;:130"));
        assert!(docx_manifest.contains("paragraph-000"));
        assert!(docx_manifest.contains("paragraph-129"));

        let pdf = render_pdf(&document).unwrap();
        let pdf_text = String::from_utf8_lossy(&pdf);
        assert!(pdf_text.contains("\"paragraphs\":130"));
        assert!(pdf_text.contains("paragraph-000"));
        assert!(pdf_text.contains("paragraph-129"));
        assert!(pdf_text.contains("/Count 4") || pdf_text.contains("/Count 3"));
        assert_xref_offsets_are_correct(&pdf);
    }

    #[test]
    fn validation_rejects_empty_and_oversized_inputs() {
        assert_eq!(
            render_docx(&DocumentModel::new("empty")).unwrap_err(),
            DocumentExportError::EmptyDocument
        );
        let too_long = "x".repeat(MAX_PARAGRAPH_CHARS + 1);
        let document = DocumentModel::new("too long")
            .with_section(Section::untitled().with_paragraph(too_long));
        assert_eq!(
            render_pdf(&document).unwrap_err(),
            DocumentExportError::ParagraphTooLong
        );
    }

    fn sample_document() -> DocumentModel {
        DocumentModel::new("Meeting Relay")
            .with_section(
                Section::new("Summary")
                    .with_paragraph("English paragraph")
                    .with_paragraph("中文段落"),
            )
            .with_section(Section::new("日本語").with_paragraph("かなカナ English"))
    }

    fn read_zip_files(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut offset = 0usize;
        while offset + 30 <= bytes.len() && read_le_u32(bytes, offset) == 0x0403_4b50 {
            let crc = read_le_u32(bytes, offset + 14);
            let size = read_le_u32(bytes, offset + 18) as usize;
            let name_len = read_le_u16(bytes, offset + 26) as usize;
            let extra_len = read_le_u16(bytes, offset + 28) as usize;
            let name_start = offset + 30;
            let data_start = name_start + name_len + extra_len;
            let data_end = data_start + size;
            let name =
                String::from_utf8(bytes[name_start..name_start + name_len].to_vec()).unwrap();
            let data = bytes[data_start..data_end].to_vec();
            assert_eq!(crc32(&data), crc, "{name} CRC mismatch");
            files.insert(name, data);
            offset = data_end;
        }
        assert_eq!(read_le_u32(bytes, offset), 0x0201_4b50);
        files
    }

    fn assert_xref_offsets_are_correct(bytes: &[u8]) {
        let startxref_marker = b"startxref\n";
        let start = find_last_bytes(bytes, startxref_marker).unwrap() + startxref_marker.len();
        let end = bytes[start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .unwrap()
            + start;
        let xref_offset = std::str::from_utf8(&bytes[start..end])
            .unwrap()
            .parse::<usize>()
            .unwrap();
        assert_eq!(&bytes[xref_offset..xref_offset + 4], b"xref");

        let xref = std::str::from_utf8(&bytes[xref_offset..]).unwrap();
        let mut lines = xref.lines();
        assert_eq!(lines.next(), Some("xref"));
        let header = lines.next().unwrap();
        let count = header
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse::<usize>()
            .unwrap();
        assert_eq!(lines.next(), Some("0000000000 65535 f "));
        for object_id in 1..count {
            let line = lines.next().unwrap();
            let offset = line[..10].parse::<usize>().unwrap();
            let expected = format!("{object_id} 0 obj");
            assert!(
                bytes[offset..].starts_with(expected.as_bytes()),
                "xref object {object_id} points to {}",
                String::from_utf8_lossy(
                    &bytes[offset..offset + expected.len().min(bytes.len() - offset)]
                )
            );
        }
    }

    fn find_last_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .enumerate()
            .rev()
            .find_map(|(index, window)| (window == needle).then_some(index))
    }

    fn text_matrices(content: &str) -> Vec<(f32, f32)> {
        content
            .lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                let a = parts.next()?;
                let b = parts.next()?;
                let c = parts.next()?;
                let d = parts.next()?;
                let x = parts.next()?;
                let y = parts.next()?;
                let operator = parts.next()?;
                (a == "1" && b == "0" && c == "0" && d == "1" && operator == "Tm").then(|| {
                    (
                        x.parse::<f32>().expect("x matrix coordinate"),
                        y.parse::<f32>().expect("y matrix coordinate"),
                    )
                })
            })
            .collect()
    }

    fn rendered_line_text(pages: &[PdfPage]) -> Vec<String> {
        pages
            .iter()
            .flat_map(|page| {
                page.lines.iter().map(|line| {
                    line.fragments
                        .iter()
                        .map(|fragment| fragment.text.as_str())
                        .collect()
                })
            })
            .collect()
    }

    fn read_le_u16(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
    }

    fn read_le_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    }
}
