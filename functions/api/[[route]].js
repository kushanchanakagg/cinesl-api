<?php
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, User-Agent, Host');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

$url = $_GET['url'] ?? '';
if (!$url) {
    http_response_code(400);
    echo json_encode(['error' => 'missing url']);
    exit;
}

// Validate URL
if (!filter_var($url, FILTER_VALIDATE_URL)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid url']);
    exit;
}

// Get headers from original request
$headers = [];
foreach ($_SERVER as $key => $value) {
    if (strpos($key, 'HTTP_') === 0) {
        $headerName = str_replace(' ', '-', ucwords(str_replace('_', ' ', strtolower(substr($key, 5)))));
        $headers[$headerName] = $value;
    }
}

// Set User-Agent if not provided
if (!isset($headers['User-Agent'])) {
    $headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
}

// Handle TikTok special case
if (isset($_GET['tt'])) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_HTTPHEADER, array_map(function($k, $v) { return "$k: $v"; }, array_keys($headers), array_values($headers)));
    
    $result = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    if ($result === false) {
        http_response_code(502);
        exit;
    }
    
    // Handle TikTok video processing
    if ($httpCode === 200) {
        $bytes = unpack('C*', $result);
        if (isset($bytes[1]) && $bytes[1] === 0x89) {
            // PNG detected, strip header
            $result = substr($result, 120);
        }
        header('Content-Type: video/MP2T');
        header('Cache-Control: public, max-age=3600');
        echo $result;
    } else {
        http_response_code($httpCode);
    }
    exit;
}

// Initialize cURL
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false); // Handle redirects manually
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
curl_setopt($ch, CURLOPT_HEADER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, array_map(function($k, $v) { return "$k: $v"; }, array_keys($headers), array_values($headers)));

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode(['error' => 'Failed to fetch URL']);
    exit;
}

// Split headers and body
$responseHeaders = substr($response, 0, $headerSize);
$body = substr($response, $headerSize);

// Handle redirects
if ($httpCode >= 300 && $httpCode < 400) {
    preg_match('/Location:\s*(.+)/i', $responseHeaders, $matches);
    if (isset($matches[1])) {
        $redirectUrl = trim($matches[1]);
        if (!parse_url($redirectUrl, PHP_URL_SCHEME)) {
            $redirectUrl = parse_url($url, PHP_URL_SCHEME) . '://' . parse_url($url, PHP_URL_HOST) . $redirectUrl;
        }
        header("Location: proxy.php?url=" . urlencode($redirectUrl));
        exit;
    }
}

// Extract content type
preg_match('/Content-Type:\s*(.+)/i', $responseHeaders, $matches);
$contentType = isset($matches[1]) ? trim($matches[1]) : 'application/octet-stream';

// Check if M3U8
$isM3u8 = strpos($contentType, 'mpegurl') !== false || 
          strpos($contentType, 'm3u8') !== false || 
          preg_match('/\.m3u8?(\?|$)/i', $url);

if ($isM3u8 && strpos($body, '#EXTM3U') === 0) {
    header('Content-Type: application/vnd.apple.mpegurl');
    echo rewriteM3U8($body, $url);
} else {
    header("Content-Type: $contentType");
    header('Cache-Control: public, max-age=3600');
    echo $body;
}

function rewriteM3U8($content, $originalUrl) {
    $lines = explode("\n", $content);
    $base = parse_url($originalUrl, PHP_URL_PATH);
    $dir = dirname($base) . '/';
    $scheme = parse_url($originalUrl, PHP_URL_SCHEME);
    $host = parse_url($originalUrl, PHP_URL_HOST);
    
    $rewrittenLines = [];
    foreach ($lines as $line) {
        $line = trim($line);
        if (empty($line) || strpos($line, '#') === 0) {
            // Handle URI attributes in EXT-X-KEY and similar tags
            if (preg_match('/URI="([^"]+)"/', $line, $matches)) {
                $uri = $matches[1];
                if (strpos($uri, 'http') === 0) {
                    if (strpos($uri, 'tiktokcdn.com') !== false) {
                        $rewrittenLine = str_replace($uri, $uri, $line);
                    } else {
                        $rewrittenLine = str_replace($uri, "proxy.php?url=" . urlencode($uri), $line);
                    }
                } elseif (strpos($uri, '/') === 0) {
                    $abs = $scheme . '://' . $host . $uri;
                    $rewrittenLine = str_replace($uri, "proxy.php?url=" . urlencode($abs), $line);
                } else {
                    $abs = $scheme . '://' . $host . $dir . $uri;
                    $rewrittenLine = str_replace($uri, "proxy.php?url=" . urlencode($abs), $line);
                }
                $rewrittenLines[] = $rewrittenLine;
            } else {
                $rewrittenLines[] = $line;
            }
        } else {
            // Handle segment URLs
            if (strpos($line, 'http') === 0) {
                if (strpos($line, 'tiktokcdn.com') !== false || strpos($line, 'p16-sg') !== false || strpos($line, 'p19-sg') !== false) {
                    $rewrittenLines[] = "proxy.php?url=" . urlencode($line) . "&tt=1";
                } else {
                    $rewrittenLines[] = "proxy.php?url=" . urlencode($line);
                }
            } elseif (strpos($line, '/') === 0) {
                $abs = $scheme . '://' . $host . $line;
                $rewrittenLines[] = "proxy.php?url=" . urlencode($abs);
            } else {
                $abs = $scheme . '://' . $host . $dir . $line;
                $rewrittenLines[] = "proxy.php?url=" . urlencode($abs);
            }
        }
    }
    
    return implode("\n", $rewrittenLines);
}
?>
