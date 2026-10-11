// Celer's JDBC bridge: a child process of Celer that talks to it only through stdin and stdout (it never opens a
// port). One JVM serves every JDBC session of the app: each request names its session and each session runs on its
// own thread, so a slow query never holds up another one. The reader thread only dispatches: nothing it does waits
// on a driver. A cancel runs on a helper thread and, if the statement has not stopped 5 s later, the connection is
// cut (`Connection.abort`) and Celer opens another one.
// The protocol is described in src-tauri/src/jdbc.rs. Built with `javac --release 11` by src-tauri/build.rs, with
// no dependencies: the JDBC driver is loaded at run time from the jars Celer names.

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLWarning;
import java.sql.Statement;
import java.sql.Types;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class CelerBridge {
    static final int PROTOCOL = 1;

    static final int OP_LOAD = 1, OP_CONNECT = 2, OP_EXEC = 3, OP_FETCH = 4, OP_CLOSE_CURSOR = 5, OP_AUTOCOMMIT = 6,
            OP_COMMIT = 7, OP_ROLLBACK = 8, OP_CANCEL = 9, OP_CLOSE = 10;

    // How a value travels: the row format is a null bitmap plus these values (see jdbc.rs).
    static final int W_BOOL = 1, W_INT = 2, W_DOUBLE = 3, W_TEXT = 4, W_BYTES = 5;
    // How a TEXT or BYTES value is read from the result set.
    static final int R_STRING = 0, R_DECIMAL = 1, R_DATE = 2, R_CLOB = 3, R_BLOB = 4, R_STREAM = 5, R_BYTES = 6;

    // The same limits as the ODBC path: long texts are cut, binaries keep a preview (Celer shows 4096 bytes and marks
    // the rest, hence one more).
    static final int TEXT_LIMIT = 1_000_000;
    static final int BINARY_LIMIT = 4097;
    // A batch of rows stops at this size even if fewer rows than asked were read: memory and latency stay bounded.
    static final int BATCH_BYTES = 4 << 20;

    static OutputStream out;
    static final Object writeLock = new Object();
    static final Map<Integer, Session> sessions = new ConcurrentHashMap<>();
    static final Map<String, Driver> drivers = new HashMap<>();
    // The SQLSTATE of "the connection was cut and has to be opened again" (jdbc.rs reconnects on it).
    static final String RESET = "CELER-RESET";
    static final long ESCALATE_MS = 5000;

    static final ExecutorService control = Executors.newSingleThreadExecutor(daemon("celer-control"));
    // Cancels and aborts: a driver may wait on the network or on its connection's lock while doing them.
    static final ExecutorService helpers = Executors.newCachedThreadPool(daemon("celer-cancel"));
    static final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor(daemon("celer-timer"));

    static ThreadFactory daemon(String name) {
        return r -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            return t;
        };
    }

    public static void main(String[] args) throws Exception {
        out = new BufferedOutputStream(new FileOutputStream(FileDescriptor.out), 1 << 16);
        // Whatever a driver prints must not get into the protocol.
        System.setOut(System.err);
        DataInputStream in = new DataInputStream(new BufferedInputStream(new FileInputStream(FileDescriptor.in), 1 << 16));
        Buf hello = new Buf();
        hello.str("celer-bridge");
        hello.varint(PROTOCOL);
        hello.str(System.getProperty("java.version", ""));
        hello.str(System.getProperty("java.vendor", ""));
        reply(0, 0, hello);
        while (true) {
            int len;
            try {
                len = Integer.reverseBytes(in.readInt());
            } catch (EOFException e) {
                break;
            }
            byte[] frame = new byte[len];
            in.readFully(frame);
            dispatch(new Req(frame));
        }
        shutdown();
    }

    /** Celer closed the pipe (it exited or let the bridge go): close the connections and leave. */
    static void shutdown() {
        Thread closer = new Thread(() -> {
            for (Session s : sessions.values()) {
                s.cancel();
                s.closeAll();
            }
        });
        closer.setDaemon(true);
        closer.start();
        try {
            closer.join(3000);
        } catch (InterruptedException ignored) {
            // leaving anyway
        }
        System.exit(0);
    }

    static void dispatch(Req r) {
        if (r.op == OP_CANCEL) {
            Session s = sessions.get(r.session);
            if (s != null) s.cancel();
            return;
        }
        if (r.op == OP_LOAD) {
            control.execute(() -> {
                try {
                    Driver d = driver(r.in);
                    Buf b = new Buf();
                    b.str(d.getMajorVersion() + "." + d.getMinorVersion());
                    answer(r, b);
                } catch (Throwable t) {
                    answerError(r, t);
                }
            });
            return;
        }
        Session s = sessions.get(r.session);
        if (s == null) {
            if (r.op != OP_CONNECT) {
                answerError(r, new SQLException("La sesión JDBC ya está cerrada"));
                return;
            }
            s = new Session(r.session);
            sessions.put(r.session, s);
            s.start();
        }
        s.queue.add(r);
    }

    /** The driver class from these jars, loaded once (a class loader of its own, like DBeaver does). */
    static Driver driver(In in) throws Exception {
        int n = (int) in.varint();
        URL[] urls = new URL[n];
        StringBuilder key = new StringBuilder();
        for (int i = 0; i < n; i++) {
            String path = in.str();
            urls[i] = Paths.get(path).toUri().toURL();
            key.append(path).append('\n');
        }
        String cls = in.str();
        key.append(cls);
        synchronized (drivers) {
            Driver d = drivers.get(key.toString());
            if (d == null) {
                URLClassLoader loader = new URLClassLoader(urls, CelerBridge.class.getClassLoader());
                d = (Driver) Class.forName(cls, true, loader).getDeclaredConstructor().newInstance();
                drivers.put(key.toString(), d);
            }
            return d;
        }
    }

    /** The reply to a request, once: a request cut short by a cancel was already answered. */
    static void answer(Req r, Buf body) {
        if (r.req != 0 && r.answered.compareAndSet(false, true)) reply(r.req, 0, body);
    }

    static void answerError(Req r, Throwable t) {
        if (r.req != 0 && r.answered.compareAndSet(false, true)) fail(r.req, t);
    }

    static void reply(int req, int status, Buf body) {
        synchronized (writeLock) {
            try {
                writeIntLE(5 + body.size);
                writeIntLE(req);
                out.write(status);
                out.write(body.data, 0, body.size);
                out.flush();
            } catch (IOException e) {
                // Celer is gone: nothing left to serve.
                Runtime.getRuntime().halt(0);
            }
        }
    }

    static void writeIntLE(int v) throws IOException {
        out.write(v);
        out.write(v >>> 8);
        out.write(v >>> 16);
        out.write(v >>> 24);
    }

    /** Error reply: the message (with the chained ones and the cause), SQLSTATE and the vendor code. */
    static void fail(int req, Throwable t) {
        String state = "";
        int code = 0;
        StringBuilder msg = new StringBuilder();
        if (t instanceof SQLException) {
            SQLException e = (SQLException) t;
            state = e.getSQLState() == null ? "" : e.getSQLState();
            code = e.getErrorCode();
            int count = 0;
            for (SQLException x = e; x != null && count < 5; x = x.getNextException(), count++) {
                append(msg, x.getMessage());
                if (x.getCause() != null && x.getCause() != x) append(msg, x.getCause().toString());
            }
        } else {
            append(msg, t.toString());
            if (t.getCause() != null) append(msg, t.getCause().toString());
        }
        Buf b = new Buf();
        b.str(msg.length() == 0 ? t.getClass().getName() : msg.toString());
        b.str(state);
        b.zigzag(code);
        reply(req, 1, b);
    }

    static void append(StringBuilder msg, String text) {
        if (text == null || text.trim().isEmpty() || msg.indexOf(text.trim()) >= 0) return;
        if (msg.length() > 0) msg.append('\n');
        msg.append(text.trim());
    }

    // ---------------------------------------------------------------- sessions

    static final class Session extends Thread {
        final int id;
        final LinkedBlockingQueue<Req> queue = new LinkedBlockingQueue<>();
        final Map<Integer, Cursor> cursors = new HashMap<>();
        int nextCursor = 1;
        Connection conn;
        /** The statement running now and its request, for a cancel. */
        volatile Statement running;
        volatile Req current;
        /** Cut off by a cancel that did not stop: the thread ends when the driver gives it back. */
        volatile boolean dead;

        Session(int id) {
            super("celer-session-" + id);
            this.id = id;
            setDaemon(true);
        }

        /** Called on the reader thread: it never waits here. */
        void cancel() {
            Statement st = running;
            Req req = current;
            if (st == null || req == null) return;
            helpers.execute(() -> {
                try {
                    st.cancel();
                } catch (Throwable ignored) {
                    // nothing running any more
                }
            });
            // Informix sends the cancel as TCP urgent data, which some proxies and firewalls drop.
            timers.schedule(() -> {
                if (running == st && current == req) escalate(req);
            }, ESCALATE_MS, TimeUnit.MILLISECONDS);
        }

        /**
         * The statement did not stop: its connection is cut (abort closes the socket without waiting for the driver),
         * the request gets its answer now and the session leaves the table, so Celer's next CONNECT opens a new one.
         */
        void escalate(Req req) {
            // Claiming the answer decides the race with the session thread finishing on its own.
            if (!req.answered.compareAndSet(false, true)) return;
            sessions.remove(id, this);
            dead = true;
            Connection c = conn;
            if (c != null) {
                helpers.execute(() -> {
                    try {
                        c.abort(helpers);
                    } catch (Throwable t) {
                        try {
                            c.close();
                        } catch (Throwable ignored) {
                            // gone either way
                        }
                    }
                });
            }
            SQLException reset = new SQLException("Consulta cancelada (se reabre la conexión: el servidor no la detuvo en " + ESCALATE_MS / 1000 + " s)", RESET);
            if (req.req != 0) fail(req.req, reset);
            for (Req q = queue.poll(); q != null; q = queue.poll()) answerError(q, reset);
        }

        @Override
        public void run() {
            while (!dead) {
                Req r;
                try {
                    r = queue.take();
                } catch (InterruptedException e) {
                    return;
                }
                current = r;
                Buf result = null;
                Throwable error = null;
                try {
                    result = handle(r);
                } catch (Throwable t) {
                    error = t;
                }
                current = null;
                if (error == null) answer(r, result);
                else answerError(r, error);
                if (r.op == OP_CLOSE) {
                    sessions.remove(id, this);
                    return;
                }
            }
            closeAll();
        }

        Connection conn() throws SQLException {
            if (conn == null) throw new SQLException("No hay conexión abierta");
            return conn;
        }

        Buf handle(Req r) throws Exception {
            In in = r.in;
            switch (r.op) {
                case OP_CONNECT:
                    return connect(in);
                case OP_EXEC:
                    return exec(in);
                case OP_FETCH: {
                    int id = (int) in.varint();
                    Cursor c = cursors.get(id);
                    if (c == null) throw new SQLException("El resultado ya está cerrado");
                    int max = (int) Math.min(in.varint(), Integer.MAX_VALUE);
                    boolean size = (in.u8() & 1) != 0;
                    Buf b = new Buf();
                    running = c.st;
                    try {
                        c.batch(b, max, size);
                    } finally {
                        running = null;
                    }
                    return b;
                }
                case OP_CLOSE_CURSOR: {
                    Cursor c = cursors.remove((int) in.varint());
                    if (c != null) c.finish();
                    return new Buf();
                }
                case OP_AUTOCOMMIT:
                    conn().setAutoCommit(in.u8() != 0);
                    return new Buf();
                case OP_COMMIT:
                    if (!conn().getAutoCommit()) conn().commit();
                    return new Buf();
                case OP_ROLLBACK:
                    if (!conn().getAutoCommit()) conn().rollback();
                    return new Buf();
                case OP_CLOSE:
                    closeAll();
                    return new Buf();
                default:
                    throw new SQLException("Operación desconocida: " + r.op);
            }
        }

        /** Opens the connection (a second CONNECT replaces it: another database). */
        Buf connect(In in) throws Exception {
            Driver d = driver(in);
            String url = in.str();
            Properties props = new Properties();
            long n = in.varint();
            for (long i = 0; i < n; i++) props.setProperty(in.str(), in.str());
            closeAll();
            Connection c = d.connect(url, props);
            if (c == null) throw new SQLException("El driver no acepta la URL " + url);
            conn = c;
            DatabaseMetaData md = c.getMetaData();
            Buf b = new Buf();
            b.str((nz(md.getDatabaseProductName()) + " " + nz(md.getDatabaseProductVersion())).trim());
            b.str(nz(md.getDriverVersion()));
            return b;
        }

        Buf exec(In in) throws Exception {
            String sql = in.str();
            long first = in.varint();
            boolean size = (in.u8() & 1) != 0;
            Statement st = conn().createStatement();
            running = st;
            try {
                if (size && first > 0 && first <= 100_000) st.setFetchSize((int) first);
                boolean rows = st.execute(sql);
                Buf b = new Buf();
                warnings(b, st.getWarnings());
                if (!rows) {
                    long count = st.getUpdateCount();
                    st.close();
                    b.u8(0);
                    b.zigzag(count);
                    return b;
                }
                Cursor c = new Cursor(st, st.getResultSet());
                int id = nextCursor++;
                b.u8(1);
                b.varint(id);
                c.describe(b);
                c.batch(b, (int) Math.min(first, Integer.MAX_VALUE), false);
                cursors.put(id, c);
                return b;
            } catch (Throwable t) {
                try {
                    st.close();
                } catch (Throwable ignored) {
                    // the original error matters
                }
                throw t;
            } finally {
                running = null;
            }
        }

        void closeAll() {
            for (Cursor c : cursors.values()) c.finish();
            cursors.clear();
            if (conn != null) {
                // Closing never commits: JDBC leaves an open transaction at close to the driver, so it is undone first.
                try {
                    if (!conn.getAutoCommit()) conn.rollback();
                } catch (Throwable ignored) {
                    // a broken connection: the server undoes it when the connection goes
                }
                try {
                    conn.close();
                } catch (Throwable ignored) {
                    // already gone
                }
                conn = null;
            }
        }
    }

    static void warnings(Buf b, SQLWarning w) {
        int n = 0;
        for (SQLWarning x = w; x != null && n < 20; x = x.getNextWarning()) n++;
        b.varint(n);
        int i = 0;
        for (SQLWarning x = w; x != null && i < n; x = x.getNextWarning(), i++) {
            String state = x.getSQLState() == null ? "" : "[" + x.getSQLState() + "] ";
            b.str(state + nz(x.getMessage()));
        }
    }

    static String nz(String s) {
        return s == null ? "" : s;
    }

    // ---------------------------------------------------------------- results

    /** An open result. One row is read ahead to tell whether more remain; the server cursor closes at the end. */
    static final class Cursor {
        final Statement st;
        final ResultSet rs;
        final int n;
        final int[] wire;
        final int[] read;
        boolean ahead;
        boolean done;

        Cursor(Statement st, ResultSet rs) throws SQLException {
            this.st = st;
            this.rs = rs;
            n = rs.getMetaData().getColumnCount();
            wire = new int[n];
            read = new int[n];
        }

        void describe(Buf b) throws SQLException {
            ResultSetMetaData md = rs.getMetaData();
            b.varint(n);
            for (int i = 0; i < n; i++) {
                int c = i + 1;
                int type = md.getColumnType(c);
                switch (type) {
                    case Types.BIT:
                    case Types.BOOLEAN:
                        wire[i] = W_BOOL;
                        break;
                    case Types.TINYINT:
                    case Types.SMALLINT:
                    case Types.INTEGER:
                    case Types.BIGINT:
                        wire[i] = W_INT;
                        break;
                    case Types.REAL:
                    case Types.FLOAT:
                    case Types.DOUBLE:
                        wire[i] = W_DOUBLE;
                        break;
                    case Types.NUMERIC:
                    case Types.DECIMAL:
                        // As text: no precision lost (MONEY too).
                        wire[i] = W_TEXT;
                        read[i] = R_DECIMAL;
                        break;
                    case Types.DATE:
                        // getString follows DBDATE (01/15/2024…): the date itself is always yyyy-mm-dd.
                        wire[i] = W_TEXT;
                        read[i] = R_DATE;
                        break;
                    case Types.BINARY:
                    case Types.VARBINARY:
                        wire[i] = W_BYTES;
                        read[i] = R_BYTES;
                        break;
                    case Types.LONGVARBINARY:
                        wire[i] = W_BYTES;
                        read[i] = R_STREAM;
                        break;
                    case Types.BLOB:
                        wire[i] = W_BYTES;
                        read[i] = R_BLOB;
                        break;
                    case Types.CLOB:
                    case Types.NCLOB:
                        wire[i] = W_TEXT;
                        read[i] = R_CLOB;
                        break;
                    default:
                        wire[i] = W_TEXT;
                        read[i] = R_STRING;
                }
                int precision = 0;
                int scale = 0;
                try {
                    precision = Math.max(0, md.getPrecision(c));
                    scale = md.getScale(c);
                } catch (Throwable ignored) {
                    // not every type has them
                }
                b.str(nz(md.getColumnLabel(c)));
                b.str(nz(md.getColumnTypeName(c)));
                b.zigzag(type);
                b.varint(precision);
                b.zigzag(scale);
                b.u8(wire[i]);
            }
        }

        /** Up to `max` rows (and BATCH_BYTES), then whether more remain. `size`: the driver fetches `max` rows a trip. */
        void batch(Buf b, int max, boolean size) throws SQLException {
            int at = b.reserve(5);
            int count = 0;
            int start = b.size;
            if (size && !done && max > 0 && max <= 100_000) {
                try {
                    rs.setFetchSize(max);
                } catch (SQLException ignored) {
                    // a hint only
                }
            }
            while (count < max && !done && b.size - start < BATCH_BYTES) {
                if (ahead) {
                    ahead = false;
                } else if (!rs.next()) {
                    finish();
                    break;
                }
                row(b);
                count++;
            }
            boolean more = false;
            if (!done) {
                if (ahead) {
                    more = true;
                } else if (rs.next()) {
                    ahead = true;
                    more = true;
                } else {
                    finish();
                }
            }
            b.putIntAt(at, count);
            b.data[at + 4] = (byte) (more ? 1 : 0);
        }

        void row(Buf b) throws SQLException {
            int at = b.reserve((n + 7) >> 3);
            for (int i = 0; i < n; i++) {
                int c = i + 1;
                boolean isNull = false;
                switch (wire[i]) {
                    case W_BOOL: {
                        boolean v = rs.getBoolean(c);
                        if (rs.wasNull()) isNull = true;
                        else b.u8(v ? 1 : 0);
                        break;
                    }
                    case W_INT: {
                        long v = rs.getLong(c);
                        if (rs.wasNull()) isNull = true;
                        else b.zigzag(v);
                        break;
                    }
                    case W_DOUBLE: {
                        double v = rs.getDouble(c);
                        if (rs.wasNull()) isNull = true;
                        else b.f64(v);
                        break;
                    }
                    case W_BYTES: {
                        byte[] v = bytes(c, read[i]);
                        if (v == null) isNull = true;
                        else b.bytes(v, Math.min(v.length, BINARY_LIMIT));
                        break;
                    }
                    default: {
                        String v = text(c, read[i]);
                        if (v == null) isNull = true;
                        else b.str(v);
                    }
                }
                if (isNull) b.data[at + (i >> 3)] |= (byte) (1 << (i & 7));
            }
        }

        String text(int c, int kind) throws SQLException {
            switch (kind) {
                case R_DECIMAL: {
                    BigDecimal v = rs.getBigDecimal(c);
                    return v == null ? null : v.toPlainString();
                }
                case R_DATE: {
                    java.sql.Date v = rs.getDate(c);
                    return v == null ? null : v.toString();
                }
                case R_CLOB: {
                    Clob v = rs.getClob(c);
                    if (v == null) return null;
                    long len = v.length();
                    String s = v.getSubString(1, (int) Math.min(len, TEXT_LIMIT));
                    return len > TEXT_LIMIT ? s + "…" : s;
                }
                default: {
                    String v = rs.getString(c);
                    if (v != null && v.length() > TEXT_LIMIT) v = v.substring(0, TEXT_LIMIT) + "…";
                    return v;
                }
            }
        }

        byte[] bytes(int c, int kind) throws SQLException {
            if (kind == R_BLOB) {
                Blob v = rs.getBlob(c);
                if (v == null) return null;
                return v.getBytes(1, (int) Math.min(v.length(), BINARY_LIMIT));
            }
            if (kind == R_STREAM) {
                InputStream s = rs.getBinaryStream(c);
                if (s == null) return null;
                try {
                    byte[] buf = new byte[BINARY_LIMIT];
                    int got = 0;
                    while (got < buf.length) {
                        int k = s.read(buf, got, buf.length - got);
                        if (k < 0) break;
                        got += k;
                    }
                    return got == buf.length ? buf : Arrays.copyOf(buf, got);
                } catch (IOException e) {
                    throw new SQLException(e.getMessage(), e);
                }
            }
            return rs.getBytes(c);
        }

        /** The end of the rows: the result and its statement are closed now (frees the server cursor). */
        void finish() {
            done = true;
            ahead = false;
            try {
                rs.close();
            } catch (Throwable ignored) {
                // closed already
            }
            try {
                st.close();
            } catch (Throwable ignored) {
                // closed already
            }
        }
    }

    // ---------------------------------------------------------------- wire format

    static final class Req {
        final int req;
        final int session;
        final int op;
        final In in;
        final AtomicBoolean answered = new AtomicBoolean();

        Req(byte[] frame) {
            in = new In(frame);
            req = in.u32();
            session = in.u32();
            op = in.u8();
        }
    }

    static final class In {
        final byte[] d;
        int p;

        In(byte[] d) {
            this.d = d;
        }

        int u8() {
            return d[p++] & 0xFF;
        }

        int u32() {
            int v = (d[p] & 0xFF) | (d[p + 1] & 0xFF) << 8 | (d[p + 2] & 0xFF) << 16 | (d[p + 3] & 0xFF) << 24;
            p += 4;
            return v;
        }

        long varint() {
            long v = 0;
            int shift = 0;
            while (true) {
                int b = d[p++] & 0xFF;
                v |= (long) (b & 0x7F) << shift;
                if ((b & 0x80) == 0) return v;
                shift += 7;
            }
        }

        String str() {
            int n = (int) varint();
            String s = new String(d, p, n, StandardCharsets.UTF_8);
            p += n;
            return s;
        }
    }

    static final class Buf {
        byte[] data = new byte[256];
        int size;

        void ensure(int n) {
            if (size + n > data.length) data = Arrays.copyOf(data, Math.max(data.length * 2, size + n));
        }

        void u8(int v) {
            ensure(1);
            data[size++] = (byte) v;
        }

        void varint(long v) {
            ensure(10);
            while ((v & ~0x7FL) != 0) {
                data[size++] = (byte) ((v & 0x7F) | 0x80);
                v >>>= 7;
            }
            data[size++] = (byte) v;
        }

        void zigzag(long v) {
            varint((v << 1) ^ (v >> 63));
        }

        void f64(double d) {
            long v = Double.doubleToRawLongBits(d);
            ensure(8);
            for (int i = 0; i < 8; i++) {
                data[size++] = (byte) v;
                v >>>= 8;
            }
        }

        void bytes(byte[] b, int len) {
            varint(len);
            ensure(len);
            System.arraycopy(b, 0, data, size, len);
            size += len;
        }

        void str(String s) {
            byte[] b = s.getBytes(StandardCharsets.UTF_8);
            bytes(b, b.length);
        }

        int reserve(int n) {
            ensure(n);
            int at = size;
            Arrays.fill(data, size, size + n, (byte) 0);
            size += n;
            return at;
        }

        void putIntAt(int at, int v) {
            data[at] = (byte) v;
            data[at + 1] = (byte) (v >>> 8);
            data[at + 2] = (byte) (v >>> 16);
            data[at + 3] = (byte) (v >>> 24);
        }
    }
}
