You are a File Analysis Worker Agent. You are a stateless, single-task executor.
Your ONLY job is to analyze the folder given to you and return a single JSON object.
No explanation. No preamble. No markdown. JSON only.

You must respond with a JSON object with exactly these fields:

- path: the absolute folder path you analyzed (e.g. "/Users/john/Downloads")
- totalFiles: total number of files found as an integer (e.g. 47)
- totalMB: total size of all files in megabytes as a decimal number (e.g. 128.5)
- fileGroups: array of file category objects. Each object has:
    - category: human readable group name (e.g. "Images", "Documents", "Videos", "Archives", "Code", "Other")
    - count: number of files in this group as an integer
    - extensions: comma-joined list of extensions found in this group (e.g. "jpg,png,heic")
    - sample: exactly one representative filename from this group (e.g. "report_q3.pdf")
- flags: pipe-joined anomaly codes as a single string, or empty string "" if none apply
    Available codes:
    dupes   = duplicate filenames detected
    no-ext  = one or more files have no extension
    large   = one or more files are over 100MB
    hidden  = hidden files or dotfiles are present
    Example: "dupes|no-ext" or "large" or ""

Example of a valid response:
{
  "path": "/Users/john/Downloads",
  "totalFiles": 47,
  "totalMB": 230.5,
  "fileGroups": [
    { "category": "Images", "count": 18, "extensions": "jpg,png,heic", "sample": "IMG_0091.jpg" },
    { "category": "Documents", "count": 12, "extensions": "pdf,docx", "sample": "report_q3.pdf" },
    { "category": "Archives", "count": 4, "extensions": "zip", "sample": "backup.zip" }
  ],
  "flags": "dupes|no-ext"
}

Example of an error response:
{
  "path": "/Users/john/InvalidPath",
  "totalFiles": 0,
  "totalMB": 0,
  "fileGroups": [],
  "flags": ""
}

Here is the file List :
FOLDER Path : /users/utsabshrestha/code/download \n Total files discovered in the folder : 246

.DS_Store | Size: 10.00 KB | Type: no extension 
[Gary_Wilson,Anthony_Jack]_Your_Brain_on_Porn__Int.pdf | Size: 1284.30 KB | Type: .pdf 
0203af06-a36b-4af9-8947-9da01dc3957b.jpg | Size: 217.66 KB | Type: .jpg 
1- Introduction (1).pdf | Size: 2954.74 KB | Type: .pdf 
1- Introduction.pdf | Size: 2954.74 KB | Type: .pdf 
15-05-2021-082725Gone-Girl-Gillian-Flynn.pdf | Size: 2640.85 KB | Type: .pdf 
1Z2A8585.jpg | Size: 9375.80 KB | Type: .jpg 
1Z2A8586.jpg | Size: 9124.19 KB | Type: .jpg 
2- Transformers - f.pdf | Size: 1718.82 KB | Type: .pdf 
2- Transformers.pdf | Size: 2555.10 KB | Type: .pdf 
3f6c96cc-ac44-4f94-9201-d40436d63a91.jpeg | Size: 126.99 KB | Type: .jpeg 
50YearsDataScience.pdf | Size: 424.24 KB | Type: .pdf 
627377654_18077896709353375_1015365919615731605_n.webp | Size: 47.33 KB | Type: .webp 
709a056c-4fb6-4eb2-8416-c3b9575f2b55.jpg | Size: 184.48 KB | Type: .jpg 
7444f6ed-0b86-49ac-ac43-d41d28f988f2.jpg | Size: 211.91 KB | Type: .jpg 
Aavash_Silwal_Assignment2.pdf | Size: 9547.67 KB | Type: .pdf 
Aavash_Silwal_Assignment3.pdf | Size: 8373.49 KB | Type: .pdf 
Aavash_Silwal_Assignment4.pdf | Size: 7417.19 KB | Type: .pdf 
AnalyticGeometry (1).pdf | Size: 528.02 KB | Type: .pdf 
AnalyticGeometry.pdf | Size: 287.24 KB | Type: .pdf 
Anna Lembke - Dopamine Nation_ Finding Balance in the Age of Indulgence-Dutton (2021).epub | Size: 5644.25 KB | Type: .epub 
Application for Social Security Card.pdf | Size: 61.85 KB | Type: .pdf 
architecture-diagram-components.excalidrawlib | Size: 95.81 KB | Type: .excalidrawlib 
arrhythmia_ecg_cnn_backbones (1).ipynb | Size: 68.46 KB | Type: .ipynb 
arrhythmia_ecg_cnn_backbones.ipynb | Size: 16.57 KB | Type: .ipynb 
arrhythmia_ecg_cnn_experiments (1).ipynb | Size: 34.73 KB | Type: .ipynb 
arrhythmia_ecg_cnn_experiments.ipynb | Size: 11.90 KB | Type: .ipynb 
arrhythmia_ecg_cnn_fixed.ipynb | Size: 9.82 KB | Type: .ipynb 
arrhythmia_ecg_cnn_full_3x3_multiseed (2).ipynb | Size: 1696.59 KB | Type: .ipynb 
arrhythmia_ecg_cnn_full_3x3_multiseed.ipynb | Size: 16.29 KB | Type: .ipynb 
arrhythmia_ecg_cnn_full_3x3_multiseed.py | Size: 13.95 KB | Type: .py 
arrhythmia_ecg_cnn_trimmed_grid (1).ipynb | Size: 636.90 KB | Type: .ipynb 
arrhythmia_ecg_cnn_trimmed_grid.ipynb | Size: 13.91 KB | Type: .ipynb 
arrhythmia_on_ecg_classification_using_cnn_(1).ipynb | Size: 1018.40 KB | Type: .ipynb 
arrhythmia_on_ecg_classification_using_cnn_(1).py | Size: 11.27 KB | Type: .py 
arrhythmia-on-ecg-classification-using-cnn (1).ipynb | Size: 1294.22 KB | Type: .ipynb 
Assignment 5.pdf | Size: 4792.51 KB | Type: .pdf 
Assignment-9-HPC.pptx | Size: 455.80 KB | Type: .pptx 
Assignment01_UtsabShrestha.docx | Size: 19.17 KB | Type: .docx 
Assignment11.docx | Size: 20.20 KB | Type: .docx 
Attracting-the-Beautiful-Woman-of-Your-Dreams-PAPERBACK.pdf | Size: 477.04 KB | Type: .pdf 
audit-101196960-A002urM7.pdf | Size: 12.12 KB | Type: .pdf 
audit-101225118-A00361L8.pdf | Size: 14.00 KB | Type: .pdf 
Availability Card.xlsx | Size: 14.01 KB | Type: .xlsx 
aws-architecture-icons.excalidrawlib | Size: 3846.70 KB | Type: .excalidrawlib 
aws-ec2.pem | Size: 1.63 KB | Type: .pem 
Book%201_with_30min_schedule (1).xlsx | Size: 9.86 KB | Type: .xlsx 
Book%201_with_30min_schedule.xlsx | Size: 9.86 KB | Type: .xlsx 
CapCut_7604160847216328717_installer.dmg | Size: 3548.26 KB | Type: .dmg 
Certificate of Completion for Hazing Awareness and Prevention for Students (Full Course).pdf | Size: 126.02 KB | Type: .pdf 
Certificate of Completion for Sexual Assault Prevention for Undergraduates (Full Course).pdf | Size: 125.61 KB | Type: .pdf 
Chapter 3 Assn - 2026 Spring Math_ Data Sci_Machine Learn (CSC-442-UT1, CSC-542-UT1).pdf | Size: 143.72 KB | Type: .pdf 
Chapter 3 Assn.docx | Size: 14.09 KB | Type: .docx 
Chapter 4 Assn - 2026 Spring Math_ Data Sci_Machine Learn (CSC-442-UT1, CSC-542-UT1).pdf | Size: 114.44 KB | Type: .pdf 
Chapter5_assn.pdf | Size: 10620.56 KB | Type: .pdf 
ChatGPT Image Oct 23, 2025, 12_30_20 PM.png | Size: 1896.59 KB | Type: .png 
CI_DSA_study_guide.pdf | Size: 146.14 KB | Type: .pdf 
claude-code-main.zip | Size: 10182.87 KB | Type: .zip 
Claude-my friend  (1).txt | Size: 830.46 KB | Type: .txt 
Claude-my friend .txt | Size: 479.82 KB | Type: .txt 
Claude-myfriend.2 You need human connec.!My job is to support your RECOVERY, not become your new compulsion (1).txt | Size: 375.14 KB | Type: .txt 
Claude-myfriend.2 You need human connec.!My job is to support your RECOVERY, not become your new compulsion.txt | Size: 353.50 KB | Type: .txt 
code.zip | Size: 267301.52 KB | Type: .zip 
Collective-Operations-Accelerating-Messaging-and-Efficiency-in-Supercomputing-Workloads.pptx | Size: 20881.58 KB | Type: .pptx 
Copy of US H1B Sponsoring Company List (1).xlsx | Size: 121.39 KB | Type: .xlsx 
Copy of US H1B Sponsoring Company List.xlsx | Size: 46.95 KB | Type: .xlsx 
Copy_of_arrhythmia_ecg_cnn_full_3x3_multiseed.ipynb | Size: 1675.38 KB | Type: .ipynb 
copy_of_arrhythmia_ecg_cnn_full_3x3_multiseed.py | Size: 13.41 KB | Type: .py 
Copy_of_arrhythmia_on_ecg_classification_using_cnn_(1).ipynb | Size: 638.53 KB | Type: .ipynb 
Cracking the Coding Interview.pdf | Size: 55100.71 KB | Type: .pdf 
CSC 525 425 HPC Syllabus fall 2025.docx | Size: 47.72 KB | Type: .docx 
CSC 725_Operating Systems and Architecture.docx | Size: 57.24 KB | Type: .docx 
csc-785-syllabus-bor.docx | Size: 293.99 KB | Type: .docx 
CSC542UT1MathFor MachineLearningSP26.doc | Size: 86.00 KB | Type: .doc 
CUDA_Quantum_Integration.pptx | Size: 5178.39 KB | Type: .pptx 
d5c8fb2d-6291-445b-bd71-ae9dc9a435fa.jpeg | Size: 64.81 KB | Type: .jpeg 
Data Analysis Presentation - Copy (1).pdf | Size: 1804.24 KB | Type: .pdf 
Data Analysis Presentation - Copy (1).pptx | Size: 2544.34 KB | Type: .pptx 
Data Analysis Presentation - Copy.pptx | Size: 2544.34 KB | Type: .pptx 
data-2025-12-03-02-41-31-batch-0000.zip | Size: 388.32 KB | Type: .zip 
DataAnalysisQiiz.pdf | Size: 1565.71 KB | Type: .pdf 
Dataanalysisquiz2.pdf | Size: 1300.42 KB | Type: .pdf 
dipesh-arrhythmia-classification-using-cnn.ipynb | Size: 757.24 KB | Type: .ipynb 
dipesh.IR_test6.pdf | Size: 426.26 KB | Type: .pdf 
dokumen.pub_the-statquest-illustrated-guide-to-machine-learning-9798986924007.pdf | Size: 30129.05 KB | Type: .pdf 
Dopamine-Nation.pdf | Size: 8095.28 KB | Type: .pdf 
download.txt | Size: 1.83 KB | Type: .txt 
Driver Manual - English.pdf | Size: 2217.73 KB | Type: .pdf 
drwnio.excalidrawlib | Size: 180.13 KB | Type: .excalidrawlib 
ECG_Arrhythmia_Classification.ipynb | Size: 1698.10 KB | Type: .ipynb 
ECG_Arrhythmia_Model_Analysis (1).pptx | Size: 36.11 KB | Type: .pptx 
ECG_Arrhythmia_Model_Analysis.pptx | Size: 36.11 KB | Type: .pptx 
ECGArrhythmiaClassification.pdf | Size: 436.43 KB | Type: .pdf 
ECGArrhythmiaClassificationPresentation.pptx | Size: 2536.78 KB | Type: .pptx 
ECGArrhythmiaClassificationPresentationVideo.mp4 | Size: 13458.52 KB | Type: .mp4 
Ellucian Degree Works Dashboard.pdf | Size: 111.10 KB | Type: .pdf 
FA25_CSC525_425_Syllabus (2) (2).docx | Size: 57.25 KB | Type: .docx 
Final Project Proposed Topic template.docx | Size: 58.52 KB | Type: .docx 
From this course I am hoping to understand the core concept of Liner Algebra.docx | Size: 13.91 KB | Type: .docx 
Graduating December vs May.pdf | Size: 1278.29 KB | Type: .pdf 
Graha-Longitude-Nakshatra-LordSubLord-Rulerof-IsIn-BOwner-Relationship-Dignities.csv | Size: 1.20 KB | Type: .csv 
GTP Guide and Help Sessions TY2025.pdf | Size: 209.20 KB | Type: .pdf 
Hands-On Large Language Models Language Understanding and Generation (Jay Alammar, Maarten Grootendorst) (Z-Library).pdf | Size: 18835.74 KB | Type: .pdf 
How do i masters the leetcode, i have been doing l.md | Size: 10.18 KB | Type: .md 
HOW TO APPLY FOR A SOCIAL SECURITY NUMBER.pdf | Size: 249.25 KB | Type: .pdf 
I-20_Shrestha_Utsab_FA25 (1).pdf | Size: 353.25 KB | Type: .pdf 
I-20_Shrestha_Utsab_FA25.pdf | Size: 353.25 KB | Type: .pdf 
I-20_Shrestha_Utsab_SEVIS REG.pdf | Size: 86.32 KB | Type: .pdf 
i-9.pdf | Size: 809.14 KB | Type: .pdf 
I-94_I-95 Official Website - Get Most Recent Response.pdf | Size: 263.25 KB | Type: .pdf 
I-94.pdf | Size: 263.38 KB | Type: .pdf 
IMG_1259.MOV | Size: 40225.22 KB | Type: .MOV 
inception_se1d_diagram.png | Size: 19.64 KB | Type: .png 
JwtAuthExample.tar.gz | Size: 17.13 KB | Type: .gz 
Lease.pdf | Size: 270.30 KB | Type: .pdf 
Leveraging-OpenMP-Reduction-Clauses-for-Efficient-Processing-of-Thousands-of-Financial-Datasets-at-J (1).pptx | Size: 5703.10 KB | Type: .pptx 
Leveraging-OpenMP-Reduction-Clauses-for-Efficient-Processing-of-Thousands-of-Financial-Datasets-at-J.pptx | Size: 5703.10 KB | Type: .pptx 
Lina DA Module 1.pdf | Size: 2570.93 KB | Type: .pdf 
Lina DS Modul 2 (1).pdf | Size: 1838.48 KB | Type: .pdf 
Lina DS Modul 2.pdf | Size: 1838.48 KB | Type: .pdf 
Lina DS Modul 4.pdf | Size: 2739.75 KB | Type: .pdf 
linearalgebra (1).pdf | Size: 715.63 KB | Type: .pdf 
linearalgebra.pdf | Size: 715.63 KB | Type: .pdf 
llm.pdf | Size: 215.80 KB | Type: .pdf 
MathAssignment2.pdf | Size: 7386.00 KB | Type: .pdf 
MathAssignment4.pdf | Size: 8326.07 KB | Type: .pdf 
MatrixDecomposition.pdf | Size: 615.05 KB | Type: .pdf 
Meditation-Marcus-Arelius.pdf | Size: 863.88 KB | Type: .pdf 
mml-book.pdf | Size: 17154.20 KB | Type: .pdf 
MSCS_Program_of_Study_FAQ.docx | Size: 1872.01 KB | Type: .docx 
my friend - Claude.html | Size: 6043.04 KB | Type: .html 
myfriend.md | Size: 8.04 KB | Type: .md 
ntc_form.pdf | Size: 80.44 KB | Type: .pdf 
ntc.pdf | Size: 185.50 KB | Type: .pdf 
OpenMP-Reduction-Clauses-for-FinTech-Innovations-Inc.pptx | Size: 10663.44 KB | Type: .pptx 
passport3.jpg | Size: 587.76 KB | Type: .jpg 
pc-mobility-print-printer-setup-1.0.78[USD-Papercut.usd.edu].dmg | Size: 3358.31 KB | Type: .dmg 
pdfcoffee.com_the-statquest-illustrated-guide-to-machine-learning-josh-starmer-pdf-free.pdf | Size: 71688.29 KB | Type: .pdf 
Personal Assistant Agent.docx | Size: 15.02 KB | Type: .docx 
Peter Pacheco-An Introduction to Parallel Programming-Morgan Kaufmann (2011).pdf | Size: 3743.82 KB | Type: .pdf 
Presentation (1).pptx | Size: 10934.49 KB | Type: .pptx 
Presentation.pptx | Size: 996.50 KB | Type: .pptx 
PRJ.md | Size: 171.47 KB | Type: .md 
project-document-clustering-CSC-785 (1).pdf | Size: 24.79 KB | Type: .pdf 
project-document-clustering-CSC-785.pdf | Size: 24.79 KB | Type: .pdf 
Project6HospitalManagementSystem.pdf | Size: 237.60 KB | Type: .pdf 
PXL_20250614_125725250.jpg | Size: 1966.48 KB | Type: .jpg 
py1.pdf | Size: 340.96 KB | Type: .pdf 
question.html | Size: 233.43 KB | Type: .html 
QuikPAY(R) Is this Payment Plan information correct_.pdf | Size: 201.70 KB | Type: .pdf 
QuikPAY(R) Payment Plan Receipt.pdf | Size: 312.80 KB | Type: .pdf 
QuikPAY(R) Payment Plan Terms and Conditions.pdf | Size: 298.11 KB | Type: .pdf 
recovery_summary_day40.md | Size: 17.38 KB | Type: .md 
resnet1d_diagram.png | Size: 14.31 KB | Type: .png 
Resume_for_internship__Copy_ (5).pdf | Size: 90.91 KB | Type: .pdf 
Resume_for_internship__Copy_.pdf | Size: 86.37 KB | Type: .pdf 
Resume_for_internship_for_IRA (1).pdf | Size: 67.78 KB | Type: .pdf 
Resume_for_internship_for_IRA.pdf | Size: 82.64 KB | Type: .pdf 
resume.pdf | Size: 54.00 KB | Type: .pdf 
Rewire Your Anxious Brain.epub | Size: 773.64 KB | Type: .epub 
Rewire Your Anxious Brain.pdf | Size: 2898.83 KB | Type: .pdf 
self-improving-agent-3.0.13.zip | Size: 24.50 KB | Type: .zip 
SharedMemoryPresentationHPC.mp4 | Size: 7798.28 KB | Type: .mp4 
simple_cnn_diagram.png | Size: 21.90 KB | Type: .png 
SINAI-N.pdf | Size: 131.20 KB | Type: .pdf 
Sodexo_DSO_SSN_Letter_Shrestha_Utsab.pdf | Size: 161.31 KB | Type: .pdf 
software-architecture.excalidrawlib | Size: 43.55 KB | Type: .excalidrawlib 
sop finalized.pdf | Size: 43.90 KB | Type: .pdf 
SP26_CSC544_444_Syllabus.docx | Size: 56.18 KB | Type: .docx 
SpotifyInstaller.zip | Size: 1848.95 KB | Type: .zip 
Sri_Hanuman_Chalisa_Hindi.pdf | Size: 23.78 KB | Type: .pdf 
Statement for Feb 26, 2026 (1).pdf | Size: 45.85 KB | Type: .pdf 
Statement for Feb 26, 2026.pdf | Size: 45.85 KB | Type: .pdf 
statement-2026-01-13-to-2026-02-12.pdf | Size: 61.38 KB | Type: .pdf 
Student Headshots-155.jpg | Size: 1327.48 KB | Type: .jpg 
Student Headshots-156.jpg | Size: 1362.35 KB | Type: .jpg 
Student Headshots-157.jpg | Size: 1190.70 KB | Type: .jpg 
Student Headshots-158.jpg | Size: 1353.93 KB | Type: .jpg 
StudentId.jpeg | Size: 80.76 KB | Type: .jpeg 
system-design (1).excalidrawlib | Size: 212.94 KB | Type: .excalidrawlib 
system-design.excalidrawlib | Size: 212.94 KB | Type: .excalidrawlib 
test01-785.pdf | Size: 26.54 KB | Type: .pdf 
test06-CSC-785.pdf | Size: 542.38 KB | Type: .pdf 
Thanks, my date of birth is 1995 july 18, so i nee.pdf | Size: 355.61 KB | Type: .pdf 
The Martian by Andy Weir.pdf | Size: 2220.27 KB | Type: .pdf 
This is a kundali details can you turn it into a t.md | Size: 4.33 KB | Type: .md 
Ticket.docx | Size: 205.41 KB | Type: .docx 
Ticket.pdf | Size: 158.58 KB | Type: .pdf 
TimeSlot.pdf | Size: 20.38 KB | Type: .pdf 
UnderstandingDeepLearning_02_09_26_C.pdf | Size: 21821.28 KB | Type: .pdf 
Untitled.pages | Size: 370.10 KB | Type: .pages 
USD AI Research Student Application Form.pdf | Size: 379.88 KB | Type: .pdf 
USD715304119_auth_letter.pdf | Size: 362.28 KB | Type: .pdf 
Utsab Shrestha - Sodexo Offer 2025-12-19 06-33PM (1).pdf | Size: 27.95 KB | Type: .pdf 
Utsab Shrestha - Sodexo Offer 2025-12-19 06-33PM.pdf | Size: 27.95 KB | Type: .pdf 
Utsab Shrestha - Sodexo Offer 2026-01-25 04-18PM.pdf | Size: 27.95 KB | Type: .pdf 
Utsab_Shrestha_Internship (1).pdf | Size: 68.34 KB | Type: .pdf 
Utsab_Shrestha_Internship (2).pdf | Size: 68.28 KB | Type: .pdf 
Utsab_Shrestha_Internship_PAR.pdf | Size: 69.52 KB | Type: .pdf 
Utsab_Shrestha_Internship.pdf | Size: 68.30 KB | Type: .pdf 
Utsab_Shrestha_Resume (1).pdf | Size: 86.37 KB | Type: .pdf 
Utsab_Shrestha_Resume (2).pdf | Size: 86.37 KB | Type: .pdf 
Utsab_Shrestha_Resume_Feb2 (1).pdf | Size: 59.71 KB | Type: .pdf 
Utsab_Shrestha_Resume_Feb2.pdf | Size: 59.71 KB | Type: .pdf 
Utsab_Shrestha_Resume_GradAdmissions.pdf | Size: 81.34 KB | Type: .pdf 
Utsab_Shrestha_Resume_Jan13__Copy_.pdf | Size: 54.01 KB | Type: .pdf 
Utsab_Shrestha_Resume_Jan13.pdf | Size: 53.41 KB | Type: .pdf 
Utsab_Shrestha_Resume_Jan25 (1).pdf | Size: 53.30 KB | Type: .pdf 
Utsab_Shrestha_Resume_Jan25.pdf | Size: 53.30 KB | Type: .pdf 
Utsab_Shrestha_Resume_March22 (1).pdf | Size: 58.88 KB | Type: .pdf 
Utsab_Shrestha_Resume_March22.pdf | Size: 58.83 KB | Type: .pdf 
Utsab_Shrestha_Resume.docx | Size: 17.69 KB | Type: .docx 
Utsab_Shrestha_Resume.pdf | Size: 83.27 KB | Type: .pdf 
Utsab_Shrestha.IRA.pdf | Size: 82.75 KB | Type: .pdf 
UtsabCoverLetterServiceDesk.pdf | Size: 21.17 KB | Type: .pdf 
UtsabS2025GTP.zip | Size: 187.08 KB | Type: .zip 
UtsabShrestha.pdf | Size: 4504.46 KB | Type: .pdf 
UtsabShrestha2025.pdf | Size: 314.06 KB | Type: .pdf 
UtsabShresthaParallelComputing (1).docx | Size: 27.85 KB | Type: .docx 
UtsabShresthaParallelComputing copy.docx | Size: 23.04 KB | Type: .docx 
UtsabShresthaParallelComputing copy.pdf | Size: 84.19 KB | Type: .pdf 
UtsabShresthaParallelComputing.docx | Size: 27.85 KB | Type: .docx 
UtsabShresthaResume.pdf | Size: 58.99 KB | Type: .pdf 
UtsabShresthaResume2.pdf | Size: 86.12 KB | Type: .pdf 
VedicReport12-16-20254-14-24AM.pdf | Size: 317.07 KB | Type: .pdf 
VedicReport12-28-20255-59-51AM.pdf | Size: 120.97 KB | Type: .pdf 
VedicReport12-28-20256-02-56AM.pdf | Size: 247.66 KB | Type: .pdf 
VedicReport12-29-202510-21-33AM.pdf | Size: 317.01 KB | Type: .pdf 
VedicReport12-29-202510-22-20AM.pdf | Size: 591.14 KB | Type: .pdf 
VedicReport12-29-202510-53-01AM.pdf | Size: 448.28 KB | Type: .pdf 
VedicReport12-31-202512-37-23AM.pdf | Size: 671.38 KB | Type: .pdf 
VedicReport12-31-202512-42-36AM.pdf | Size: 316.92 KB | Type: .pdf 
Week 2 Assignment 1.58.55 PM.docx | Size: 124.87 KB | Type: .docx 
Week 2 Assignment.docx | Size: 124.87 KB | Type: .docx 
Week 2 Assignment.pdf | Size: 115.63 KB | Type: .pdf 
week1 (1) (1).docx | Size: 29.70 KB | Type: .docx 
week1 (1).docx | Size: 29.70 KB | Type: .docx 
week1 (1).pdf | Size: 12.53 KB | Type: .pdf 
week1 (2).pdf | Size: 12.53 KB | Type: .pdf 
week1 (3).pdf | Size: 12.53 KB | Type: .pdf 
week1.pdf | Size: 12.53 KB | Type: .pdf 
Week2Assignment_UtsabShrestha.docx | Size: 10.90 KB | Type: .docx 
What is the dasha's i am having right now _.pdf | Size: 474.33 KB | Type: .pdf 
WhatsApp Image 2025-11-21 at 16.21.22.jpeg | Size: 73.20 KB | Type: .jpeg 
Work Opportunity Tax Credit (WOTC).pdf | Size: 39.82 KB | Type: .pdf 
Zoom.pkg | Size: 54409.97 KB | Type: .pkg
