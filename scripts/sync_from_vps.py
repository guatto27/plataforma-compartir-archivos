"""Descarga la BD y archivos del VPS al entorno local (sin conflictos WAL)."""
import paramiko, os, stat, sys, time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HOST = "145.223.79.234"
USER = "root"
KEY  = os.path.expanduser("~/.ssh/id_ed25519")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect(HOST, username=USER, key_filename=KEY, timeout=15)
except Exception:
    import getpass
    pw = getpass.getpass("Contrasena SSH de root: ")
    client.connect(HOST, username=USER, password=pw, timeout=15)

def run(cmd):
    stdin, stdout, stderr = client.exec_command(cmd)
    stdout.channel.recv_exit_status()
    return stdout.read().decode().strip()

# 1. Parar PM2, checkpoint, reiniciar
print("Parando PM2 en VPS...")
run("pm2 stop businesscool")
time.sleep(1)

print("Consolidando WAL en BD...")
run("""node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/businesscool-data/data/portal.db');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();" 2>/dev/null""")

# 2. Descargar BD limpia
print("Descargando base de datos...")
sftp = client.open_sftp()
os.makedirs(os.path.join(BASE, "data"), exist_ok=True)
sftp.get("/var/businesscool-data/data/portal.db", os.path.join(BASE, "data", "portal.db"))
size = os.path.getsize(os.path.join(BASE, "data", "portal.db"))
print(f"  OK portal.db  ({size // 1024} KB)")

# Eliminar WAL/SHM locales para evitar conflictos
for f in ["portal.db-wal", "portal.db-shm", "portal_wal.tmp", "portal_shm.tmp"]:
    fp = os.path.join(BASE, "data", f)
    if os.path.exists(fp):
        os.remove(fp)

# 3. Reiniciar PM2
print("Reiniciando PM2 en VPS...")
run("pm2 start businesscool")
time.sleep(2)

# 4. Descargar archivos de clientes
print("Descargando archivos de clientes...")
remote_uploads = "/var/businesscool-data/storage/uploads"
local_uploads  = os.path.join(BASE, "storage", "uploads")
os.makedirs(local_uploads, exist_ok=True)

count = 0
try:
    for fname in sftp.listdir(remote_uploads):
        remote_file = f"{remote_uploads}/{fname}"
        local_file  = os.path.join(local_uploads, fname)
        try:
            if stat.S_ISREG(sftp.stat(remote_file).st_mode):
                if not os.path.exists(local_file):  # no rebajar si ya existe
                    sftp.get(remote_file, local_file)
                    count += 1
                    print(f"  OK {fname}")
        except Exception as e:
            print(f"  ! {fname}: {e}")
except Exception as e:
    print(f"  uploads: {e}")

sftp.close()
client.close()
print(f"\nListo. {count} archivo(s) nuevo(s) descargado(s).")
print("Ahora abre 'Iniciar plataforma.bat'")
