' ============================================================
'  文件共享服务器 — 隐藏启动脚本
'  由 Windows 启动文件夹调用，开机自启，无窗口后台运行
' ============================================================
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 项目根目录（VBS 与 index.js 同目录）
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = projectDir

' 确保 file 目录存在
If Not fso.FolderExists(projectDir & "\file") Then
    fso.CreateFolder(projectDir & "\file")
End If

' 以隐藏窗口启动 Node.js（0 = 隐藏，False = 不等待）
nodeExe = "C:\Program Files\nodejs\node.exe"
serverJs = projectDir & "\index.js"
WshShell.Run """" & nodeExe & """ """ & serverJs & """", 0, False
