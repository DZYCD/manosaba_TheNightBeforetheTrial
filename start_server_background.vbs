' 后台静默启动本地服务器（不弹黑框）
' 不再写死 python 路径：依次尝试 node -> py -> python，找到哪个用哪个。
' 端口固定 8392，访问 http://localhost:8392/

Dim fso, sh, base, port, started
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
port = "8392"
sh.CurrentDirectory = base

started = False
If Not started Then started = TryRun("node """ & base & "\serve.js"" " & port)
If Not started Then started = TryRun("py -3 -m http.server " & port)
If Not started Then started = TryRun("python -m http.server " & port)

If Not started Then
    MsgBox "Node.js or Python not found. Install one of them:" & vbCrLf & _
           "Node.js https://nodejs.org/  /  Python https://www.python.org/", _
           48, "Witch Trial Eve - server not started"
End If

Function TryRun(cmd)
    On Error Resume Next
    sh.Run cmd, 0, False
    If Err.Number = 0 Then
        TryRun = True
    Else
        Err.Clear
        TryRun = False
    End If
    On Error GoTo 0
End Function
