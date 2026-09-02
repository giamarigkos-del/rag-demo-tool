$headers = @{
    "Content-Type"   = "application/json; charset=utf-8"
    "X-Workspace-Id" = "sourceurl-test-workspace"
}

$body = @{
    documentId = "test-doc"
    text       = "Δοκιμαστικό κείμενο μόνο για να ελέγξουμε ότι το sourceUrl αποθηκεύεται σωστά. Το Tech Support Team είναι υπεύθυνο για θέματα εξοπλισμού."
    sourceUrl  = "https://portal.efood.gr/wiki/shop-journey"
} | ConvertTo-Json

$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

Invoke-RestMethod -Uri "https://operations-portal-rag.giamarigkos.workers.dev/upload" -Method Post -Headers $headers -Body $bodyBytes
