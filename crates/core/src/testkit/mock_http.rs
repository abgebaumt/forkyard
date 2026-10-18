//! Small HTTP server for tests: listens on 127.0.0.1 on a free port, records every
//! request and answers whatever the test specifies. No TLS, no keep-alive, HTTP/1.1 only.
//!
//! ```ignore
//! let server = MockServer::start(|request| match request.route().as_str() {
//!     "GET /api/v3/user" => MockResponse::json(200, json!({ "login": "lena" })),
//!     _ => MockResponse::json(404, json!({ "message": "Not Found" })),
//! });
//! let base = server.url();            // http://127.0.0.1:<port>
//! assert_eq!(server.requests().len(), 0);
//! ```

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;

/// Largest request body the server reads.
const MAX_BODY: usize = 4 * 1024 * 1024;

/// A recorded request.
#[derive(Debug, Clone)]
pub struct MockRequest {
    pub method: String,
    /// Path with parameters, as it appears in the request line.
    pub target: String,
    /// Names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl MockRequest {
    /// Path without parameters.
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or(&self.target)
    }

    /// `METHOD /path` (without parameters) – handy for a `match`.
    pub fn route(&self) -> String {
        format!("{} {}", self.method, self.path())
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    /// Value of an address parameter, decoded.
    pub fn query(&self, name: &str) -> Option<String> {
        let query = self.target.split_once('?')?.1;
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (key == name).then(|| percent_decode(value))
        })
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// The body as JSON (`Null` if it isn't any).
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    /// Everything that went over the wire, as text – to search for secrets.
    pub fn raw(&self) -> String {
        let headers: Vec<String> = self.headers.iter().map(|(k, v)| format!("{k}: {v}")).collect();
        format!("{} {}\n{}\n\n{}", self.method, self.target, headers.join("\n"), self.body_text())
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match (bytes[index], text.get(index + 1..index + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok())) {
            (b'%', Some(byte)) => {
                out.push(byte);
                index += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                index += 1;
            }
            (byte, _) => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the server answers.
#[derive(Debug, Clone)]
pub struct MockResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// How long the server waits before answering (for timeouts).
    pub delay: Duration,
}

impl MockResponse {
    pub fn json(status: u16, body: Value) -> Self {
        MockResponse { status, headers: vec![("content-type".into(), "application/json; charset=utf-8".into())], body: body.to_string().into_bytes(), delay: Duration::ZERO }
    }

    /// Arbitrary body (e.g. broken JSON), declared as `application/json`.
    pub fn raw(status: u16, body: impl Into<Vec<u8>>) -> Self {
        MockResponse { status, headers: vec![("content-type".into(), "application/json".into())], body: body.into(), delay: Duration::ZERO }
    }

    /// Arbitrary body with its own type (e.g. an image).
    pub fn bytes(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        MockResponse { status, headers: vec![("content-type".into(), content_type.into())], body: body.into(), delay: Duration::ZERO }
    }

    pub fn empty(status: u16) -> Self {
        MockResponse { status, headers: Vec::new(), body: Vec::new(), delay: Duration::ZERO }
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_ascii_lowercase(), value.into()));
        self
    }

    pub fn delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

type Handler = dyn Fn(&MockRequest) -> MockResponse + Send + Sync;

/// The running server; it stops when dropped.
pub struct MockServer {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<MockRequest>>>,
    stop: Arc<AtomicBool>,
}

impl MockServer {
    pub fn start(handler: impl Fn(&MockRequest) -> MockResponse + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("port for the test server");
        let address = listener.local_addr().expect("address of the test server");
        let requests: Arc<Mutex<Vec<MockRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let handler: Arc<Handler> = Arc::new(handler);
        {
            let (requests, stop) = (requests.clone(), stop.clone());
            std::thread::Builder::new()
                .name("mock-http".into())
                .spawn(move || {
                    for stream in listener.incoming() {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let Ok(stream) = stream else { continue };
                        let (requests, handler) = (requests.clone(), handler.clone());
                        // One thread per connection: delayed responses don't hold up others.
                        let _ = std::thread::Builder::new().name("mock-http-verbindung".into()).spawn(move || serve(stream, &requests, &*handler));
                    }
                })
                .expect("thread of the test server");
        }
        MockServer { address, requests, stop }
    }

    /// `http://127.0.0.1:<port>`
    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    pub fn port(&self) -> u16 {
        self.address.port()
    }

    /// All requests received so far, in order of arrival.
    pub fn requests(&self) -> Vec<MockRequest> {
        self.requests.lock().clone()
    }

    /// Number of requests with this route (`"GET /path"`, without parameters).
    pub fn count(&self, route: &str) -> usize {
        self.requests.lock().iter().filter(|r| r.route() == route).count()
    }

    /// Waits until a request with this route has arrived – the concrete condition a test needs
    /// before it cancels a running request (a fixed sleep races under load). Panics after 30 s.
    pub async fn received(&self, route: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while self.count(route) == 0 {
            assert!(std::time::Instant::now() < deadline, "no request {route} arrived within 30 s");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub fn clear(&self) {
        self.requests.lock().clear();
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wakes up the waiting `accept`.
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(200));
    }
}

fn read_request(stream: &TcpStream) -> Option<MockRequest> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next()?.to_string(), parts.next()?.to_string());
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let length = headers.iter().find(|(name, _)| name == "content-length").and_then(|(_, value)| value.parse::<usize>().ok()).unwrap_or(0).min(MAX_BODY);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some(MockRequest { method, target, headers, body })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn serve(mut stream: TcpStream, requests: &Mutex<Vec<MockRequest>>, handler: &Handler) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Some(request) = read_request(&stream) else { return };
    requests.lock().push(request.clone());
    let response = handler(&request);
    if !response.delay.is_zero() {
        std::thread::sleep(response.delay);
    }
    let mut head = format!("HTTP/1.1 {} {}\r\nconnection: close\r\n", response.status, reason(response.status));
    let bodiless = response.status == 204 || response.status == 304;
    if !bodiless {
        head.push_str(&format!("content-length: {}\r\n", response.body.len()));
    }
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    if !bodiless {
        let _ = stream.write_all(&response.body);
    }
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

/// Small CONNECT proxy for tests: accepts `CONNECT host:port`, records the request line and
/// headers and then passes all bytes through in both directions.
pub struct TunnelProxy {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<MockRequest>>>,
    stop: Arc<AtomicBool>,
}

impl TunnelProxy {
    pub fn start() -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("port for the test proxy");
        let address = listener.local_addr().expect("address of the test proxy");
        let requests: Arc<Mutex<Vec<MockRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        {
            let (requests, stop) = (requests.clone(), stop.clone());
            std::thread::Builder::new()
                .name("mock-proxy".into())
                .spawn(move || {
                    for stream in listener.incoming() {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let Ok(stream) = stream else { continue };
                        let requests = requests.clone();
                        let _ = std::thread::Builder::new().name("mock-proxy-verbindung".into()).spawn(move || tunnel(stream, &requests));
                    }
                })
                .expect("thread of the test proxy");
        }
        TunnelProxy { address, requests, stop }
    }

    pub fn port(&self) -> u16 {
        self.address.port()
    }

    /// The accepted CONNECT requests (`target` is `host:port`).
    pub fn requests(&self) -> Vec<MockRequest> {
        self.requests.lock().clone()
    }

    pub fn clear(&self) {
        self.requests.lock().clear();
    }
}

impl Drop for TunnelProxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(200));
    }
}

fn tunnel(mut client: TcpStream, requests: &Mutex<Vec<MockRequest>>) {
    let _ = client.set_read_timeout(Some(Duration::from_secs(10)));
    let Some(request) = read_request(&client) else { return };
    requests.lock().push(request.clone());
    let upstream = (request.method == "CONNECT").then(|| TcpStream::connect(request.target.as_str()).ok()).flatten();
    let Some(mut upstream) = upstream else {
        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
    };
    if client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").is_err() {
        return;
    }
    let _ = client.set_read_timeout(None);
    let (Ok(mut client_read), Ok(mut upstream_write)) = (client.try_clone(), upstream.try_clone()) else { return };
    let forward = std::thread::spawn(move || {
        let _ = std::io::copy(&mut client_read, &mut upstream_write);
        let _ = upstream_write.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Both);
    let _ = forward.join();
}
