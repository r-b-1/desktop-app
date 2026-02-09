import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

type Note = {
  id: string;
  content: string;
};

function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [notes, setNotes] = useState<Note[]>([]);
  const [newNote, setNewNote] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (user) {
      loadNotes();
    }
  }, [user]);

  const signIn = async () => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) alert(error.message);
  };

  const signUp = async () => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) alert(error.message);
  };

  const loadNotes = async () => {
    const { data, error } = await supabase
      .from("notes")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      alert(error.message);
      return;
    }

    setNotes(data ?? []);
  };

  const addNote = async () => {
    if (!newNote.trim() || !user) return;

    const { error } = await supabase.from("notes").insert({
      content: newNote,
      user_id: user.id,
    });

    if (error) {
      alert(error.message);
      return;
    }

    setNewNote("");
    loadNotes();
  };

  if (loading) {
    return <div style={{ padding: 24 }}>Loading...</div>;
  }

  if (!user) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Login</h1>

        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <br />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <br />

        <button onClick={signIn}>Sign In</button>
        <button onClick={signUp}>Sign Up</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Your Notes</h1>

      <input
        value={newNote}
        onChange={(e) => setNewNote(e.target.value)}
        placeholder="New note"
      />
      <button onClick={addNote}>Add</button>

      <ul>
        {notes.map((note) => (
          <li key={note.id}>{note.content}</li>
        ))}
      </ul>

      <button onClick={() => supabase.auth.signOut()}>
        Sign Out
      </button>
    </div>
  );
}

export default App;