content = (
    "@echo off\r\n"
    "rem PaperLite launcher\r\n"
    'start "" "C:\\Users\\admin\\Desktop\\\u9006\u5411\u5de5\u7a0b\\paperlite\\'
    "node_modules\\electron\\dist\\electron.exe\" "
    '"C:\\Users\\admin\\Desktop\\\u9006\u5411\u5de5\u7a0b\\paperlite"\r\n'
)
open(r"C:\Users\admin\Desktop\启动PaperLite.bat", "w", encoding="gbk").write(content)
print("written in GBK")
