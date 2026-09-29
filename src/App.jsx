import { useState, useEffect, useRef } from "react";
import axios from "axios";

const API_URL = "https://ciary-hng15-todo-backend.onrender.com/api";
const SERVER_URL = "https://ciary-hng15-todo-backend.onrender.com";
const STORAGE_KEY = "hng_todo_tasks";
const PENDING_KEY = "hng_todo_pending_deletes";

// Tasks created while the server is off get ids like "local-123"
const isLocal = (id) => String(id).startsWith("local-");

// Ids of server tasks deleted while the server was off
const getPending = () => {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY)) || [];
  } catch (error) {
    return [];
  }
};

const savePending = (list) => {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
};

// Read tasks saved in the browser
const loadLocalTasks = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch (error) {
    console.error("Error reading local tasks:", error);
    return [];
  }
};

// Turn a file into text so it can be kept in the browser
const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// Turn the saved text back into a real file
const dataUrlToFile = async (dataUrl, name) => {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type });
};

function App() {
  const [task, setTask] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [tasks, setTasks] = useState(loadLocalTasks);
  const [filter, setFilter] = useState("all");
  const [backendOnline, setBackendOnline] = useState(false);
  const hasLoaded = useRef(false);

  // Save tasks in the browser (delayed a little so it doesn't block clicks)
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      } catch (error) {
        console.error("Browser storage is full:", error);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [tasks]);

  // Load tasks from Django (if it is running)
  useEffect(() => {
    if (hasLoaded.current) return;
    hasLoaded.current = true;

    axios
      .get(`${API_URL}/tasks/`, { timeout: 5000 })
      .then(async (response) => {
        const pending = getPending();

        // Send the deletes that were made while the server was off
        const stillPending = [];
        await Promise.all(
          pending.map(async (id) => {
            try {
              await axios.delete(`${API_URL}/tasks/${id}/`);
            } catch (error) {
              if (!(error.response && error.response.status === 404)) {
                stillPending.push(id);
              }
            }
          }),
        );
        savePending(stillPending);

        // Never show a task that you deleted
        const backendTasks = response.data.filter(
          (item) => !stillPending.includes(item.id),
        );

        // Send tasks (and their files) that were created while the server was off
        const localTasks = loadLocalTasks().filter((item) => isLocal(item.id));

        const synced = await Promise.all(
          localTasks.map(async (item) => {
            try {
              const formData = new FormData();
              formData.append("text", item.text);

              if (item.file && item.file.startsWith("data:")) {
                const realFile = await dataUrlToFile(
                  item.file,
                  item.file_name || "file",
                );
                formData.append("file", realFile);
              }

              const res = await axios.post(`${API_URL}/tasks/`, formData);

              // If it was already completed offline, keep that on the server
              if (item.completed) {
                const updated = await axios.put(
                  `${API_URL}/tasks/${res.data.id}/`,
                  { text: res.data.text, completed: true },
                );
                return {
                  ...updated.data,
                  file_name: updated.data.file_name || item.file_name,
                };
              }

              return {
                ...res.data,
                file_name: res.data.file_name || item.file_name,
              };
            } catch (error) {
              return item; // keep it local if sending fails
            }
          }),
        );

        setTasks([...backendTasks, ...synced]);
        setBackendOnline(true);
      })
      .catch(() => {
        console.log("Server is off. Using saved tasks.");
        setBackendOnline(false);
      });
  }, []);

  // Add task + optional file (shows up instantly)
  const addTask = async () => {
    if (task.trim() === "" && !selectedFile) return;

    const text = task.trim();
    const file = selectedFile;
    const fileName = file ? file.name : null;
    const tempId = `local-${Date.now()}`;

    // Show it immediately
    setTasks((current) => [
      ...current,
      { id: tempId, text, completed: false, file: null, file_name: fileName },
    ]);

    // Clear the form right away
    setTask("");
    setSelectedFile(null);
    const fileInput = document.getElementById("file-input");
    if (fileInput) fileInput.value = "";

    const formData = new FormData();
    formData.append("text", text);
    if (file) formData.append("file", file);

    try {
      const response = await axios.post(`${API_URL}/tasks/`, formData, {
        timeout: 15000,
      });

      // Swap the temporary task for the real one from Django
      setTasks((current) =>
        current.map((item) =>
          item.id === tempId
            ? {
                ...response.data,
                file_name: response.data.file_name || fileName,
              }
            : item,
        ),
      );
      setBackendOnline(true);
    } catch (error) {
      // Server is off: keep the real file in the browser
      let savedFile = null;
      if (file) {
        try {
          savedFile = await fileToDataUrl(file);
        } catch (e) {
          console.error("Could not save the file offline:", e);
        }
      }

      setTasks((current) =>
        current.map((item) =>
          item.id === tempId ? { ...item, file: savedFile } : item,
        ),
      );
      setBackendOnline(false);
    }
  };

  // Complete / uncomplete task
  const toggleTask = (id) => {
    const currentTask = tasks.find((item) => item.id === id);

    if (!currentTask) return;

    const newCompleted = !currentTask.completed;

    // Update the screen right away
    setTasks((currentTasks) =>
      currentTasks.map((item) =>
        item.id === id ? { ...item, completed: newCompleted } : item,
      ),
    );

    if (isLocal(id)) return;

    axios
      .put(`${API_URL}/tasks/${id}/`, {
        text: currentTask.text,
        completed: newCompleted,
      })
      .then((response) => {
        setTasks((currentTasks) =>
          currentTasks.map((item) =>
            item.id === id
              ? {
                  ...response.data,
                  file: response.data.file || item.file,
                  file_name: response.data.file_name || item.file_name,
                }
              : item,
          ),
        );
        setBackendOnline(true);
      })
      .catch(() => {
        console.log("Server is off.");
        setBackendOnline(false);
      });
  };

  // Delete task
  const deleteTask = (id) => {
    // Remove from the screen right away
    setTasks((currentTasks) => currentTasks.filter((item) => item.id !== id));

    if (isLocal(id)) return;

    axios
      .delete(`${API_URL}/tasks/${id}/`)
      .then(() => {
        setBackendOnline(true);
      })
      .catch((error) => {
        // Already gone on the server, nothing to remember
        if (error.response && error.response.status === 404) return;

        // Server is off: remember it and delete it on the server later
        console.log("Server is off.");
        savePending([...new Set([...getPending(), id])]);
        setBackendOnline(false);
      });
  };

  // Edit task
  const editTask = (id) => {
    const currentTask = tasks.find((item) => item.id === id);

    if (!currentTask) return;

    const newText = prompt("Edit your task:", currentTask.text);

    if (!newText || newText.trim() === "") return;

    const updatedText = newText.trim();

    // Update the screen right away
    setTasks((currentTasks) =>
      currentTasks.map((item) =>
        item.id === id ? { ...item, text: updatedText } : item,
      ),
    );

    if (isLocal(id)) return;

    axios
      .put(`${API_URL}/tasks/${id}/`, {
        text: updatedText,
        completed: currentTask.completed,
      })
      .then((response) => {
        setTasks((currentTasks) =>
          currentTasks.map((item) =>
            item.id === id
              ? {
                  ...response.data,
                  file: response.data.file || item.file,
                  file_name: response.data.file_name || item.file_name,
                }
              : item,
          ),
        );
        setBackendOnline(true);
      })
      .catch(() => {
        console.log("Server is off.");
        setBackendOnline(false);
      });
  };

  // Open a file that was saved in the browser
  const openLocalFile = async (e, dataUrl) => {
    e.preventDefault();

    const blob = await (await fetch(dataUrl)).blob();
    window.open(URL.createObjectURL(blob), "_blank");
  };

  // Filter tasks
  const filteredTasks = tasks.filter((item) => {
    if (filter === "active") {
      return !item.completed;
    }

    if (filter === "completed") {
      return item.completed;
    }

    return true;
  });

  return (
    <div className="todo-container">
      <h1>My To-Do List</h1>

      <p>{tasks.filter((item) => !item.completed).length} tasks remaining</p>

      {/* Server status */}
      <p
        style={{ fontSize: "14px", color: backendOnline ? "green" : "orange" }}
      >
        {backendOnline ? "● Backend connected" : "● Offline mode"}
      </p>

      {/* Filters */}
      <div>
        <button onClick={() => setFilter("all")}>All</button>

        <button onClick={() => setFilter("active")}>Active</button>

        <button onClick={() => setFilter("completed")}>Completed</button>
      </div>

      {/* Add task area */}
      <div>
        <input
          type="text"
          placeholder="Enter a task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTask();
          }}
        />

        <label
          htmlFor="file-input"
          style={{
            cursor: "pointer",
            display: "inline-block",
            marginLeft: "8px",
          }}
        >
          📎 Attach file
        </label>

        <input
          id="file-input"
          type="file"
          accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
          onChange={(e) => {
            setSelectedFile(e.target.files[0] || null);
          }}
          style={{ display: "none" }}
        />

        {selectedFile && (
          <span style={{ marginLeft: "8px" }}>📎 {selectedFile.name}</span>
        )}

        <button onClick={addTask}>Add Task</button>
      </div>

      {/* Task list */}
      <ul>
        {filteredTasks.map((item) => (
          <li key={item.id}>
            <input
              type="checkbox"
              checked={item.completed}
              onChange={() => toggleTask(item.id)}
            />

            <span
              style={{
                textDecoration: item.completed ? "line-through" : "none",
                marginLeft: "6px",
              }}
            >
              {item.text}
            </span>

            {/* Attached file */}
            {item.file ? (
              item.file.startsWith("data:") ? (
                // File saved in the browser (added while the server was off)
                <a
                  href="#"
                  onClick={(e) => openLocalFile(e, item.file)}
                  style={{ marginLeft: "10px" }}
                >
                  📎 {item.file_name || "View file"}
                </a>
              ) : (
                // File uploaded to Django
                <a
                  href={
                    item.file.startsWith("http")
                      ? item.file
                      : `${SERVER_URL}${item.file}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  style={{ marginLeft: "10px" }}
                >
                  📎 {item.file_name || "View file"}
                </a>
              )
            ) : (
              item.file_name && (
                <span style={{ marginLeft: "10px" }}>📎 {item.file_name}</span>
              )
            )}

            <button
              onClick={() => editTask(item.id)}
              style={{ marginLeft: "10px" }}
            >
              Edit
            </button>

            <button
              onClick={() => deleteTask(item.id)}
              style={{ marginLeft: "5px" }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;
