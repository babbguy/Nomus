"""Patient support chatbot."""
import os
from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def answer_patient(patient_name: str, mrn: str, diagnosis: str, question: str) -> str:
    """Answer a patient question using their medical record."""
    record = {
        "patient_name": patient_name,
        "medical_record_number": mrn,
        "diagnosis": diagnosis,
        "date_of_birth": "1980-01-01",
    }
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": "You are a helpful healthcare assistant chatbot."},
            {"role": "user", "content": f"Patient record: {record}. Question: {question}"},
        ],
    )
    return response.choices[0].message.content
