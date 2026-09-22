use super::{
    DriverPageSpec, PrinterDeviceConfig, SendOutcome, TransportFailure, TransportFailureKind,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PageDestination {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn page_destination(
    source_width: u32,
    source_height: u32,
    printable_width: i32,
    printable_height: i32,
    dpi_x: i32,
    dpi_y: i32,
    page: &DriverPageSpec,
) -> Result<PageDestination, TransportFailure> {
    if source_width == 0
        || source_height == 0
        || printable_width <= 0
        || printable_height <= 0
        || dpi_x <= 0
        || dpi_y <= 0
    {
        return Err(TransportFailure {
            kind: TransportFailureKind::NotStarted,
            message: "Windows printer returned invalid page metrics".to_owned(),
            timed_out: false,
        });
    }
    let mm_x = dpi_x as f64 / 25.4;
    let mm_y = dpi_y as f64 / 25.4;
    let left = (page.margins_mm.left * mm_x).round() as i32;
    let right = (page.margins_mm.right * mm_x).round() as i32;
    let top = (page.margins_mm.top * mm_y).round() as i32;
    let bottom = (page.margins_mm.bottom * mm_y).round() as i32;
    let usable_width = printable_width.saturating_sub(left).saturating_sub(right);
    let usable_height = printable_height.saturating_sub(top).saturating_sub(bottom);
    if usable_width <= 0 || usable_height <= 0 {
        return Err(TransportFailure {
            kind: TransportFailureKind::NotStarted,
            message: "page margins exceed the printer printable area".to_owned(),
            timed_out: false,
        });
    }
    let (maximum_width, maximum_height) = if page.fit_mode == "actual-size" {
        let physical_width = ((page.page_width_mm - page.margins_mm.left - page.margins_mm.right)
            * mm_x)
            .round()
            .max(1.0) as i32;
        let physical_height = ((page.page_height_mm - page.margins_mm.top - page.margins_mm.bottom)
            * mm_y)
            .round()
            .max(1.0) as i32;
        (
            usable_width.min(physical_width),
            usable_height.min(physical_height),
        )
    } else {
        (usable_width, usable_height)
    };
    let scale = (maximum_width as f64 / source_width as f64)
        .min(maximum_height as f64 / source_height as f64);
    if !scale.is_finite() || scale <= 0.0 {
        return Err(TransportFailure {
            kind: TransportFailureKind::NotStarted,
            message: "failed to calculate Windows page scaling".to_owned(),
            timed_out: false,
        });
    }
    let width = (source_width as f64 * scale).round().max(1.0) as i32;
    let height = (source_height as f64 * scale).round().max(1.0) as i32;
    Ok(PageDestination {
        x: left + (usable_width - width) / 2,
        y: top + (usable_height - height) / 2,
        width,
        height,
    })
}

fn label_destination(
    source_width: u32,
    source_height: u32,
    source_dpi: u16,
    driver_dpi_x: i32,
    driver_dpi_y: i32,
) -> Result<PageDestination, TransportFailure> {
    if source_width == 0
        || source_height == 0
        || source_dpi == 0
        || driver_dpi_x <= 0
        || driver_dpi_y <= 0
    {
        return Err(TransportFailure {
            kind: TransportFailureKind::NotStarted,
            message: "Windows printer returned invalid label metrics".to_owned(),
            timed_out: false,
        });
    }
    let width = (f64::from(source_width) * f64::from(driver_dpi_x) / f64::from(source_dpi)).round();
    let height =
        (f64::from(source_height) * f64::from(driver_dpi_y) / f64::from(source_dpi)).round();
    if !width.is_finite()
        || !height.is_finite()
        || !(1.0..=f64::from(i32::MAX)).contains(&width)
        || !(1.0..=f64::from(i32::MAX)).contains(&height)
    {
        return Err(TransportFailure {
            kind: TransportFailureKind::NotStarted,
            message: "failed to calculate Windows label scaling".to_owned(),
            timed_out: false,
        });
    }
    Ok(PageDestination {
        x: 0,
        y: 0,
        width: width as i32,
        height: height as i32,
    })
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::io;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Graphics::Gdi::{
        DEVMODEW, DMORIENT_PORTRAIT, DM_FORMNAME, DM_IN_BUFFER, DM_ORIENTATION, DM_OUT_BUFFER,
        DM_PAPERLENGTH, DM_PAPERSIZE, DM_PAPERWIDTH, DM_PRINTQUALITY, DM_SCALE, DM_YRESOLUTION,
    };
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, DocumentPropertiesW, EndDocPrinter, EndPagePrinter, GetDefaultPrinterW,
        GetPrinterW, OpenPrinterW, StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W,
        PRINTER_HANDLE, PRINTER_INFO_6,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn failure(context: &str) -> TransportFailure {
        TransportFailure {
            kind: TransportFailureKind::NotStarted,
            message: format!("{context}: {}", io::Error::last_os_error()),
            timed_out: false,
        }
    }

    fn unknown_delivery_failure(context: &str) -> TransportFailure {
        let mut failure = failure(context);
        failure.kind = TransportFailureKind::Unknown;
        failure
    }

    fn resolve_printer_name(config: &PrinterDeviceConfig) -> Result<String, TransportFailure> {
        if let Some(name) = config
            .driver_name
            .as_deref()
            .filter(|name| !name.is_empty())
        {
            return Ok(name.to_owned());
        }
        let mut length = 0_u32;
        unsafe { GetDefaultPrinterW(null_mut(), &mut length) };
        if length <= 1 {
            return Err(failure("Windows spooler GetDefaultPrinterW"));
        }
        let mut buffer = vec![0_u16; length as usize];
        if unsafe { GetDefaultPrinterW(buffer.as_mut_ptr(), &mut length) } == 0 {
            return Err(failure("Windows spooler GetDefaultPrinterW"));
        }
        let end = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        String::from_utf16(&buffer[..end]).map_err(|_| TransportFailure {
            kind: TransportFailureKind::NotStarted,
            message: "Windows default printer name contains invalid UTF-16".to_owned(),
            timed_out: false,
        })
    }

    struct RawPrinter(PRINTER_HANDLE);

    impl RawPrinter {
        fn open(name: &str) -> Result<Self, TransportFailure> {
            let name = wide(name);
            let mut handle = PRINTER_HANDLE::default();
            let ok = unsafe { OpenPrinterW(name.as_ptr(), &mut handle, null()) };
            if ok == 0 || handle.Value.is_null() {
                return Err(failure("Windows spooler OpenPrinterW"));
            }
            Ok(Self(handle))
        }
    }

    impl Drop for RawPrinter {
        fn drop(&mut self) {
            if !self.0.Value.is_null() {
                unsafe { ClosePrinter(self.0) };
            }
        }
    }

    pub(super) fn probe(config: &PrinterDeviceConfig) -> Result<SendOutcome, TransportFailure> {
        let name = resolve_printer_name(config)?;
        let _printer = RawPrinter::open(&name)?;
        Ok(SendOutcome {
            bytes: 0,
            attempts: 1,
            reused_connection: false,
        })
    }
    pub(super) fn query_status(
        config: &PrinterDeviceConfig,
    ) -> Result<(String, u32), TransportFailure> {
        let name = resolve_printer_name(config)?;
        let printer = RawPrinter::open(&name)?;
        let mut info = PRINTER_INFO_6::default();
        let mut needed = 0_u32;
        let ok = unsafe {
            GetPrinterW(
                printer.0,
                6,
                (&mut info as *mut PRINTER_INFO_6).cast::<u8>(),
                std::mem::size_of::<PRINTER_INFO_6>() as u32,
                &mut needed,
            )
        };
        if ok == 0 {
            return Err(failure("Windows spooler GetPrinterW level 6"));
        }
        Ok((name, info.dwStatus))
    }

    pub(super) fn send_raw(
        config: &PrinterDeviceConfig,
        data: &[u8],
    ) -> Result<SendOutcome, TransportFailure> {
        let name = resolve_printer_name(config)?;
        let printer = RawPrinter::open(&name)?;
        let document_name = wide("LabelPilot RAW label");
        let datatype = wide("RAW");
        let info = DOC_INFO_1W {
            pDocName: document_name.as_ptr() as *mut u16,
            pOutputFile: null_mut(),
            pDatatype: datatype.as_ptr() as *mut u16,
        };
        let job_id = unsafe { StartDocPrinterW(printer.0, 1, &info) };
        if job_id == 0 {
            return Err(failure("Windows spooler StartDocPrinterW"));
        }
        if unsafe { StartPagePrinter(printer.0) } == 0 {
            unsafe { EndDocPrinter(printer.0) };
            return Err(failure("Windows spooler StartPagePrinter"));
        }
        let mut written = 0_u32;
        let write_ok = unsafe {
            WritePrinter(
                printer.0,
                data.as_ptr().cast::<c_void>(),
                data.len() as u32,
                &mut written,
            )
        };
        if write_ok == 0 || written as usize != data.len() {
            let mut error = failure("Windows spooler WritePrinter");
            if written > 0 {
                error.kind = TransportFailureKind::Partial;
                error.message = format!(
                    "DELIVERY_UNCERTAIN: {} ({} of {} bytes accepted by spooler)",
                    error.message,
                    written,
                    data.len()
                );
            }
            unsafe {
                EndPagePrinter(printer.0);
                EndDocPrinter(printer.0);
            }
            return Err(error);
        }
        if unsafe { EndPagePrinter(printer.0) } == 0 {
            unsafe { EndDocPrinter(printer.0) };
            return Err(unknown_delivery_failure("Windows spooler EndPagePrinter"));
        }
        if unsafe { EndDocPrinter(printer.0) } == 0 {
            return Err(unknown_delivery_failure("Windows spooler EndDocPrinter"));
        }
        Ok(SendOutcome {
            bytes: data.len(),
            attempts: 1,
            reused_connection: false,
        })
    }

    type Hdc = *mut c_void;

    #[repr(C)]
    struct DocInfoW {
        cb_size: i32,
        doc_name: *const u16,
        output: *const u16,
        datatype: *const u16,
        fw_type: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct BitmapInfoHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_pels_per_meter: i32,
        y_pels_per_meter: i32,
        colors_used: u32,
        colors_important: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct RgbQuad {
        blue: u8,
        green: u8,
        red: u8,
        reserved: u8,
    }

    #[repr(C)]
    struct MonoBitmapInfo {
        header: BitmapInfoHeader,
        colors: [RgbQuad; 2],
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateDCW(
            driver: *const u16,
            device: *const u16,
            output: *const u16,
            mode: *const c_void,
        ) -> Hdc;
        fn DeleteDC(dc: Hdc) -> i32;
        fn StartDocW(dc: Hdc, info: *const DocInfoW) -> i32;
        fn StartPage(dc: Hdc) -> i32;
        fn StretchDIBits(
            dc: Hdc,
            x_dest: i32,
            y_dest: i32,
            dest_width: i32,
            dest_height: i32,
            x_src: i32,
            y_src: i32,
            src_width: i32,
            src_height: i32,
            bits: *const c_void,
            info: *const MonoBitmapInfo,
            usage: u32,
            raster_op: u32,
        ) -> i32;
        fn EndPage(dc: Hdc) -> i32;
        fn EndDoc(dc: Hdc) -> i32;
        fn AbortDoc(dc: Hdc) -> i32;
        fn GetDeviceCaps(dc: Hdc, index: i32) -> i32;
    }

    struct PrinterDc(Hdc);

    impl Drop for PrinterDc {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { DeleteDC(self.0) };
            }
        }
    }

    struct DevModeBuffer {
        storage: Vec<usize>,
    }

    impl DevModeBuffer {
        fn new(bytes: usize) -> Result<Self, TransportFailure> {
            const MAX_DEVMODE_BYTES: usize = 1024 * 1024;
            if bytes < std::mem::size_of::<DEVMODEW>() || bytes > MAX_DEVMODE_BYTES {
                return Err(TransportFailure {
                    kind: TransportFailureKind::NotStarted,
                    message: format!("Windows printer returned invalid DEVMODE size: {bytes}"),
                    timed_out: false,
                });
            }
            let words = bytes.div_ceil(std::mem::size_of::<usize>());
            Ok(Self {
                storage: vec![0; words],
            })
        }

        fn as_ptr(&self) -> *const DEVMODEW {
            self.storage.as_ptr().cast()
        }

        fn as_mut_ptr(&mut self) -> *mut DEVMODEW {
            self.storage.as_mut_ptr().cast()
        }
    }

    fn tenths_of_mm(value: f64, field: &str) -> Result<i16, TransportFailure> {
        let value = (value * 10.0).round();
        if !value.is_finite() || !(1.0..=f64::from(i16::MAX)).contains(&value) {
            return Err(TransportFailure {
                kind: TransportFailureKind::NotStarted,
                message: format!("Windows printer {field} is outside the DEVMODE range"),
                timed_out: false,
            });
        }
        Ok(value as i16)
    }

    fn printer_devmode(
        printer: &RawPrinter,
        name: &[u16],
        media_width_mm: f64,
        media_height_mm: f64,
        raster_dpi: u16,
    ) -> Result<DevModeBuffer, TransportFailure> {
        let width = tenths_of_mm(media_width_mm, "media width")?;
        let length = tenths_of_mm(media_height_mm, "media length")?;
        let dpi = i16::try_from(raster_dpi).map_err(|_| TransportFailure {
            kind: TransportFailureKind::NotStarted,
            message: format!("Windows printer raster DPI is out of range: {raster_dpi}"),
            timed_out: false,
        })?;
        if dpi <= 0 {
            return Err(TransportFailure {
                kind: TransportFailureKind::NotStarted,
                message: "Windows printer raster DPI must be positive".to_owned(),
                timed_out: false,
            });
        }

        let required = unsafe {
            DocumentPropertiesW(null_mut(), printer.0, name.as_ptr(), null_mut(), null(), 0)
        };
        if required <= 0 {
            return Err(failure("Windows printer DocumentPropertiesW size"));
        }
        let mut mode = DevModeBuffer::new(required as usize)?;
        if unsafe {
            DocumentPropertiesW(
                null_mut(),
                printer.0,
                name.as_ptr(),
                mode.as_mut_ptr(),
                null(),
                DM_OUT_BUFFER,
            )
        } != 1
        {
            return Err(failure("Windows printer DocumentPropertiesW defaults"));
        }

        unsafe {
            let devmode = &mut *mode.as_mut_ptr();
            let print = &mut devmode.Anonymous1.Anonymous1;
            devmode.dmFields &= !(DM_PAPERSIZE | DM_FORMNAME);
            devmode.dmFields |= DM_ORIENTATION
                | DM_PAPERLENGTH
                | DM_PAPERWIDTH
                | DM_PRINTQUALITY
                | DM_YRESOLUTION
                | DM_SCALE;
            print.dmOrientation = DMORIENT_PORTRAIT as i16;
            print.dmPaperSize = 0;
            print.dmPaperLength = length;
            print.dmPaperWidth = width;
            print.dmScale = 100;
            print.dmPrintQuality = dpi;
            devmode.dmYResolution = dpi;
            devmode.dmFormName.fill(0);
        }

        let pointer = mode.as_mut_ptr();
        if unsafe {
            DocumentPropertiesW(
                null_mut(),
                printer.0,
                name.as_ptr(),
                pointer,
                pointer,
                DM_IN_BUFFER | DM_OUT_BUFFER,
            )
        } != 1
        {
            return Err(failure("Windows printer DocumentPropertiesW normalize"));
        }
        unsafe {
            let devmode = &*mode.as_ptr();
            let print = devmode.Anonymous1.Anonymous1;
            let size_fields = DM_PAPERLENGTH | DM_PAPERWIDTH;
            let size_accepted = devmode.dmFields & size_fields == size_fields
                && (i32::from(print.dmPaperWidth) - i32::from(width)).abs() <= 5
                && (i32::from(print.dmPaperLength) - i32::from(length)).abs() <= 5;
            if !size_accepted {
                return Err(TransportFailure {
                    kind: TransportFailureKind::NotStarted,
                    message: format!(
                        "Windows printer driver rejected custom media size {:.1} x {:.1} mm",
                        media_width_mm, media_height_mm
                    ),
                    timed_out: false,
                });
            }
        }
        Ok(mode)
    }

    fn send_bitmap_internal(
        config: &PrinterDeviceConfig,
        width: u32,
        height: u32,
        mono: &[u8],
        page: Option<&DriverPageSpec>,
    ) -> Result<SendOutcome, TransportFailure> {
        const HORZRES: i32 = 8;
        const VERTRES: i32 = 10;
        const LOGPIXELSX: i32 = 88;
        const LOGPIXELSY: i32 = 90;

        let printer_name = resolve_printer_name(config)?;
        let name = wide(&printer_name);
        let driver = wide("WINSPOOL");
        let raster_dpi = config.dpi.unwrap_or(203);
        let (media_width_mm, media_height_mm) = page.map_or_else(
            || {
                (
                    f64::from(width) * 25.4 / f64::from(raster_dpi),
                    f64::from(height) * 25.4 / f64::from(raster_dpi),
                )
            },
            |value| (value.page_width_mm, value.page_height_mm),
        );
        let printer = RawPrinter::open(&printer_name)?;
        let mode = printer_devmode(&printer, &name, media_width_mm, media_height_mm, raster_dpi)?;
        let dc = unsafe { CreateDCW(driver.as_ptr(), name.as_ptr(), null(), mode.as_ptr().cast()) };
        if dc.is_null() {
            return Err(failure("Windows printer CreateDCW"));
        }
        let dc = PrinterDc(dc);
        let document_name = wide(page.map_or("LabelPilot bitmap label", |value| {
            value.document_name.as_str()
        }));
        let info = DocInfoW {
            cb_size: std::mem::size_of::<DocInfoW>() as i32,
            doc_name: document_name.as_ptr(),
            output: null(),
            datatype: null(),
            fw_type: 0,
        };
        if unsafe { StartDocW(dc.0, &info) } <= 0 {
            return Err(failure("Windows printer StartDocW"));
        }
        if unsafe { StartPage(dc.0) } <= 0 {
            unsafe { AbortDoc(dc.0) };
            return Err(failure("Windows printer StartPage"));
        }
        let destination = if let Some(page) = page {
            page_destination(
                width,
                height,
                unsafe { GetDeviceCaps(dc.0, HORZRES) },
                unsafe { GetDeviceCaps(dc.0, VERTRES) },
                unsafe { GetDeviceCaps(dc.0, LOGPIXELSX) },
                unsafe { GetDeviceCaps(dc.0, LOGPIXELSY) },
                page,
            )
        } else {
            label_destination(
                width,
                height,
                raster_dpi,
                unsafe { GetDeviceCaps(dc.0, LOGPIXELSX) },
                unsafe { GetDeviceCaps(dc.0, LOGPIXELSY) },
            )
        };
        let destination = match destination {
            Ok(value) => value,
            Err(error) => {
                unsafe { AbortDoc(dc.0) };
                return Err(error);
            }
        };
        let source_stride = width.div_ceil(8) as usize;
        let dib_stride = width.div_ceil(32) as usize * 4;
        let mut dib = vec![0_u8; dib_stride * height as usize];
        for row in 0..height as usize {
            let source = &mono[row * source_stride..(row + 1) * source_stride];
            dib[row * dib_stride..row * dib_stride + source_stride].copy_from_slice(source);
        }
        let bitmap = MonoBitmapInfo {
            header: BitmapInfoHeader {
                size: std::mem::size_of::<BitmapInfoHeader>() as u32,
                width: width as i32,
                height: -(height as i32),
                planes: 1,
                bit_count: 1,
                compression: 0,
                size_image: dib.len() as u32,
                colors_used: 2,
                colors_important: 2,
                ..Default::default()
            },
            colors: [
                RgbQuad {
                    blue: 255,
                    green: 255,
                    red: 255,
                    reserved: 0,
                },
                RgbQuad {
                    blue: 0,
                    green: 0,
                    red: 0,
                    reserved: 0,
                },
            ],
        };
        let copied = unsafe {
            StretchDIBits(
                dc.0,
                destination.x,
                destination.y,
                destination.width,
                destination.height,
                0,
                0,
                width as i32,
                height as i32,
                dib.as_ptr().cast::<c_void>(),
                &bitmap,
                0,
                0x00CC0020,
            )
        };
        if copied == -1 || copied == 0 {
            unsafe { AbortDoc(dc.0) };
            return Err(failure("Windows printer StretchDIBits"));
        }
        if unsafe { EndPage(dc.0) } <= 0 {
            unsafe { AbortDoc(dc.0) };
            return Err(unknown_delivery_failure("Windows printer EndPage"));
        }
        if unsafe { EndDoc(dc.0) } <= 0 {
            return Err(unknown_delivery_failure("Windows printer EndDoc"));
        }
        Ok(SendOutcome {
            bytes: mono.len(),
            attempts: 1,
            reused_connection: false,
        })
    }

    pub(super) fn send_bitmap(
        config: &PrinterDeviceConfig,
        width: u32,
        height: u32,
        mono: &[u8],
    ) -> Result<SendOutcome, TransportFailure> {
        send_bitmap_internal(config, width, height, mono, None)
    }

    pub(super) fn send_page_bitmap(
        config: &PrinterDeviceConfig,
        width: u32,
        height: u32,
        mono: &[u8],
        page: &DriverPageSpec,
    ) -> Result<SendOutcome, TransportFailure> {
        send_bitmap_internal(config, width, height, mono, Some(page))
    }

    pub(super) fn driver_dpi(config: &PrinterDeviceConfig) -> Result<(i32, i32), String> {
        const LOGPIXELSX: i32 = 88;
        const LOGPIXELSY: i32 = 90;
        let printer_name = resolve_printer_name(config).map_err(|error| error.message)?;
        let name = wide(&printer_name);
        let driver = wide("WINSPOOL");
        let dc = unsafe { CreateDCW(driver.as_ptr(), name.as_ptr(), null(), null()) };
        if dc.is_null() {
            return Err("Windows printer CreateDCW".to_owned());
        }
        let dc = PrinterDc(dc);
        Ok((unsafe { GetDeviceCaps(dc.0, LOGPIXELSX) }, unsafe {
            GetDeviceCaps(dc.0, LOGPIXELSY)
        }))
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    fn unsupported() -> TransportFailure {
        TransportFailure {
            kind: TransportFailureKind::NotStarted,
            message: "Windows spooler is available on Windows only".to_owned(),
            timed_out: false,
        }
    }
    pub(super) fn probe(_: &PrinterDeviceConfig) -> Result<SendOutcome, TransportFailure> {
        Err(unsupported())
    }

    pub(super) fn query_status(_: &PrinterDeviceConfig) -> Result<(String, u32), TransportFailure> {
        Err(unsupported())
    }
    pub(super) fn send_raw(
        _: &PrinterDeviceConfig,
        _: &[u8],
    ) -> Result<SendOutcome, TransportFailure> {
        Err(unsupported())
    }
    pub(super) fn send_bitmap(
        _: &PrinterDeviceConfig,
        _: u32,
        _: u32,
        _: &[u8],
    ) -> Result<SendOutcome, TransportFailure> {
        Err(unsupported())
    }
    pub(super) fn send_page_bitmap(
        _: &PrinterDeviceConfig,
        _: u32,
        _: u32,
        _: &[u8],
        _: &DriverPageSpec,
    ) -> Result<SendOutcome, TransportFailure> {
        Err(unsupported())
    }
    pub(super) fn driver_dpi(_: &PrinterDeviceConfig) -> Result<(i32, i32), String> {
        Err("Windows spooler is available on Windows only".to_owned())
    }
}

pub(super) fn driver_dpi(config: &PrinterDeviceConfig) -> Result<(i32, i32), String> {
    platform::driver_dpi(config)
}
pub(super) fn probe(config: &PrinterDeviceConfig) -> Result<SendOutcome, TransportFailure> {
    platform::probe(config)
}
pub(super) fn query_status(
    config: &PrinterDeviceConfig,
) -> Result<(String, u32), TransportFailure> {
    platform::query_status(config)
}

pub(super) fn send_raw(
    config: &PrinterDeviceConfig,
    data: &[u8],
) -> Result<SendOutcome, TransportFailure> {
    platform::send_raw(config, data)
}

pub(super) fn send_bitmap(
    config: &PrinterDeviceConfig,
    width: u32,
    height: u32,
    mono: &[u8],
) -> Result<SendOutcome, TransportFailure> {
    platform::send_bitmap(config, width, height, mono)
}

pub(super) fn send_page_bitmap(
    config: &PrinterDeviceConfig,
    width: u32,
    height: u32,
    mono: &[u8],
    page: &DriverPageSpec,
) -> Result<SendOutcome, TransportFailure> {
    platform::send_page_bitmap(config, width, height, mono, page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::printer::PageMarginsMm;

    fn page(fit_mode: &str, margins: PageMarginsMm) -> DriverPageSpec {
        DriverPageSpec {
            page_width_mm: 210.0,
            page_height_mm: 297.0,
            margins_mm: margins,
            fit_mode: fit_mode.to_owned(),
            document_name: "Pallet".to_owned(),
        }
    }

    #[test]
    fn a4_300dpi_bitmap_fills_a_600dpi_printable_area_without_changing_aspect() {
        let target = page_destination(
            2480,
            3508,
            4960,
            7016,
            600,
            600,
            &page("fit-printable", PageMarginsMm::default()),
        )
        .unwrap();
        assert_eq!(
            target,
            PageDestination {
                x: 0,
                y: 0,
                width: 4960,
                height: 7016
            }
        );
    }

    #[test]
    fn label_bitmap_is_scaled_from_raster_dpi_to_driver_dpi() {
        let target = label_destination(812, 406, 203, 300, 600).unwrap();
        assert_eq!(
            target,
            PageDestination {
                x: 0,
                y: 0,
                width: 1200,
                height: 1200,
            }
        );
    }

    #[test]
    fn page_margins_are_applied_in_physical_millimetres() {
        let target = page_destination(
            2480,
            3508,
            4960,
            7016,
            600,
            600,
            &page(
                "fit-printable",
                PageMarginsMm {
                    top: 5.0,
                    right: 5.0,
                    bottom: 5.0,
                    left: 5.0,
                },
            ),
        )
        .unwrap();
        assert!(target.x >= 118);
        assert!(target.y >= 118);
        assert!(target.x + target.width <= 4960 - 118);
        assert!(target.y + target.height <= 7016 - 118);
    }

    #[test]
    fn invalid_device_metrics_fail_before_gdi_drawing() {
        let error = page_destination(
            2480,
            3508,
            0,
            7016,
            600,
            600,
            &page("actual-size", PageMarginsMm::default()),
        )
        .unwrap_err();
        assert!(error.message.contains("invalid page metrics"));
    }
}
