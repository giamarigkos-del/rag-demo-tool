$headers = @{
    "Content-Type"   = "application/json; charset=utf-8"
    "X-Workspace-Id" = "sourceurl-test-workspace"
}

$body = @{
    question = "Ποιος είναι υπεύθυνος για θέματα εξοπλισμού;"
} | ConvertTo-Json

$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

$result = Invoke-RestMethod -Uri "https://operations-portal-rag.giamarigkos.workers.dev/query" -Method Post -Headers $headers -Body $bodyBytes

$result | ConvertTo-Json -Depth 10
